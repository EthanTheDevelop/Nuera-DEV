import 'server-only';
import { session as authSession, commandRuns, user as users } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { evaluateSessionPolicy, twoFactorRequired } from '@/server/auth/policy';
import type { CurrentUser } from '@/server/auth/session';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import type { RunnerEndpoint } from '@/server/runner/client';
import { getWebSessionPolicy } from '@/server/settings';
import { resolveContext } from '@/server/tenancy/context';
import { scopeOfRun } from '@/server/tenancy/scope';
import type { PreviewGrant } from './tokens';

/**
 * Who may see a preview, re-checked for EVERY request of the preview host (cookie claims) and for
 * every handoff: the account still exists and is active (not disabled, not deleted, 2FA when it is
 * required), the web access that opened the preview is still open (Better Auth session row, policy
 * of idle / absolute expiry: signing out or revoking it closes the preview), and the run still
 * belongs to the account's space (`scopeOfRun`: the same 404 as an unknown run otherwise) and is a
 * dev server. That the dev server is alive with a detected port is checked by the runner itself at
 * every relayed request (`/v1/runs/:id/preview`).
 *
 * The positive verdict is kept {@link ACCESS_TTL_MS} per (account, access, run) — a page loads
 * dozens of files at once; a refusal is never cached.
 */

export const ACCESS_TTL_MS = 5_000;

export type PreviewDenialReason = 'ACCOUNT' | 'ACCESS' | 'RUN' | 'NOT_DEV';

export class PreviewDenied extends Error {
  constructor(
    readonly reason: PreviewDenialReason,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewDenied';
  }
}

export interface PreviewAccess {
  runId: string;
  environmentName: string;
  endpoint: () => Promise<RunnerEndpoint>;
}

interface Cached {
  access: PreviewAccess;
  expiresAt: number;
}

const holder = globalThis as unknown as { __nueraPreviewAccess?: Map<string, Cached> };

function cache(): Map<string, Cached> {
  holder.__nueraPreviewAccess ??= new Map();
  return holder.__nueraPreviewAccess;
}

/** Forgets the cached verdicts (tests; an access revoked is refused after {@link ACCESS_TTL_MS} anyway). */
export function invalidatePreviewAccess(): void {
  cache().clear();
}

const EXPIRED = "Cet aperçu n'est plus valable : rouvrez-le depuis le Workspace de Nuera Dev.";

async function currentUserOf(grant: PreviewGrant): Promise<CurrentUser> {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      twoFactorEnabled: users.twoFactorEnabled,
      role: users.role,
      disabledAt: users.disabledAt,
      deletedAt: users.deletedAt,
      sessionCreatedAt: authSession.createdAt,
      sessionUpdatedAt: authSession.updatedAt,
      sessionExpiresAt: authSession.expiresAt,
    })
    .from(users)
    .leftJoin(authSession, and(eq(authSession.id, grant.authSessionId), eq(authSession.userId, users.id)))
    .where(eq(users.id, grant.userId))
    .limit(1);
  if (!row || row.disabledAt || row.deletedAt) throw new PreviewDenied('ACCOUNT', EXPIRED);
  if (twoFactorRequired() && row.twoFactorEnabled !== true) throw new PreviewDenied('ACCOUNT', EXPIRED);
  if (!row.sessionCreatedAt || !row.sessionUpdatedAt || !row.sessionExpiresAt || row.sessionExpiresAt.getTime() <= Date.now()) {
    throw new PreviewDenied('ACCESS', EXPIRED);
  }
  const verdict = evaluateSessionPolicy({ createdAt: row.sessionCreatedAt, lastActivityAt: row.sessionUpdatedAt }, await getWebSessionPolicy());
  if (!verdict.valid) throw new PreviewDenied('ACCESS', EXPIRED);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image ?? null,
    twoFactorEnabled: row.twoFactorEnabled === true,
    authSessionId: grant.authSessionId,
    role: row.role,
    disabledAt: null,
  };
}

/** The grant still holds (see the module comment), or PreviewDenied. */
export async function resolvePreviewAccess(grant: PreviewGrant, options: { fresh?: boolean } = {}): Promise<PreviewAccess> {
  const key = `${grant.userId}\u0000${grant.authSessionId}\u0000${grant.runId}`;
  const cached = cache().get(key);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.access;
  cache().delete(key);

  const current = await currentUserOf(grant);
  let scope: Awaited<ReturnType<typeof scopeOfRun>>;
  try {
    const ctx = await resolveContext(current);
    scope = await scopeOfRun(ctx, grant.runId);
  } catch (error) {
    if (error instanceof AppError && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) throw new PreviewDenied('RUN', EXPIRED);
    throw error;
  }
  const [run] = await db.select({ kind: commandRuns.kind }).from(commandRuns).where(eq(commandRuns.id, scope.runId)).limit(1);
  if (!run) throw new PreviewDenied('RUN', EXPIRED);
  if (run.kind !== 'dev') throw new PreviewDenied('NOT_DEV', "Ce lancement n'est pas un serveur de développement.");

  const access: PreviewAccess = { runId: scope.runId, environmentName: scope.environmentName, endpoint: scope.endpoint };
  cache().set(key, { access, expiresAt: Date.now() + ACCESS_TTL_MS });
  return access;
}
