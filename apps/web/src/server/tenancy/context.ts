import 'server-only';
import { environments, spaceMembers, spaceSettings, spaces, userPreferences } from '@nuera/db/schema';
import type { EnvironmentStatus, SpaceKind, SpaceRole } from '@nuera/db/schema';
import { uptimeServiceKey } from '@nuera/shared/runner';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { cache } from 'react';
import { getCurrentUser, requireUser, requireUserForApi, type CurrentUser } from '@/server/auth/session';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getRunnerForEnvironment, type RunnerClient } from '@/server/runner/client';
import { personalSpaceName } from './names';

export { personalSpaceName };

/**
 * Request context of the multi-account model (docs/MULTICOMPTE.md §5): who acts (`user`), in which
 * space (`space`, v1 = the personal space, NEVER chosen by the client) and on which server
 * (`environment`, the runner instance of the space; null while none is assigned).
 *
 *   const ctx = await requireContext();              // pages, layouts, server actions (redirects)
 *   const ctx = await requireContextForApi();        // route handlers (AppError 401 / 403)
 *   const { environment, runner } = requireEnvironment(ctx); // server-level calls (Claude status…)
 *
 * Calls about an existing resource go to the server holding it (`scopeOf*()` in ./scope), never to
 * « the current server of the space ».
 *
 * Space and server are cached 5 s per process (keystrokes, SSE): {@link invalidateContextCache}
 * after assigning, suspending or retiring a server. The user itself is never cached.
 */

export interface SpaceRef {
  id: string;
  name: string;
  kind: SpaceKind;
  /** Role of the user in this space. */
  role: SpaceRole;
}

export interface EnvironmentRef {
  id: string;
  /** « VPS-3 » for the default server (Figma copy unchanged). */
  name: string;
  location: string | null;
  status: EnvironmentStatus;
  isDefault: boolean;
  /** `uptime_daily.service` of this server (`runner` for the default one). */
  uptimeKey: string;
  maxConcurrentSessions: number;
}

export interface RequestContext {
  user: CurrentUser;
  space: SpaceRef;
  environment: EnvironmentRef | null;
}

/** French copy of the « no server » refusal (reason NO_ENVIRONMENT). */
export const NO_ENVIRONMENT_MESSAGE = "Aucun serveur ne vous est encore attribué : un administrateur doit vous en attribuer un.";

const CONTEXT_TTL_MS = 5_000;

interface CachedScope {
  space: SpaceRef;
  environment: EnvironmentRef | null;
  expiresAt: number;
}

const holder = globalThis as unknown as { __nueraContextCache?: Map<string, CachedScope> };

function scopeCache(): Map<string, CachedScope> {
  holder.__nueraContextCache ??= new Map();
  return holder.__nueraContextCache;
}

/** Forgets the cached space/server of one account (or of every account). */
export function invalidateContextCache(userId?: string): void {
  if (userId) scopeCache().delete(userId);
  else scopeCache().clear();
}

async function readScope(userId: string): Promise<{ space: SpaceRef; environment: EnvironmentRef | null; archived: boolean } | null> {
  const [row] = await db
    .select({
      spaceId: spaces.id,
      spaceName: spaces.name,
      spaceKind: spaces.kind,
      spaceArchivedAt: spaces.archivedAt,
      memberRole: spaceMembers.role,
      environmentId: environments.id,
      environmentName: environments.name,
      environmentLocation: environments.location,
      environmentStatus: environments.status,
      environmentIsDefault: environments.isDefault,
      environmentMaxSessions: environments.maxConcurrentSessions,
    })
    .from(spaceMembers)
    .innerJoin(
      spaces,
      and(eq(spaces.id, spaceMembers.spaceId), eq(spaces.kind, 'personal'), eq(spaces.ownerUserId, userId)),
    )
    .leftJoin(environments, and(eq(environments.spaceId, spaces.id), ne(environments.status, 'retired')))
    .where(eq(spaceMembers.userId, userId))
    .limit(1);
  if (!row) return null;
  const environment: EnvironmentRef | null =
    row.environmentId && row.environmentName && row.environmentStatus
      ? {
          id: row.environmentId,
          name: row.environmentName,
          location: row.environmentLocation ?? null,
          status: row.environmentStatus,
          isDefault: row.environmentIsDefault === true,
          uptimeKey: uptimeServiceKey({ id: row.environmentId, isDefault: row.environmentIsDefault === true }),
          maxConcurrentSessions: row.environmentMaxSessions ?? 4,
        }
      : null;
  return {
    space: { id: row.spaceId, name: row.spaceName, kind: row.spaceKind, role: row.memberRole },
    environment,
    archived: row.spaceArchivedAt !== null,
  };
}

/**
 * Self-healing: an account without its personal space (created before the model, or a partial
 * write) gets it now — space, owner membership, space settings and preferences — idempotently
 * (concurrent requests converge on the same rows). The owner first adopts the ownerless
 * « Espace initial » of a database that had data but no account (MULTICOMPTE §14 F1-4), so its
 * projects, integrations and default server are never orphaned, whichever path runs first.
 */
async function ensurePersonalSpace(user: Pick<CurrentUser, 'id' | 'name' | 'role'>): Promise<void> {
  await db.transaction(async (tx) => {
    if (user.role === 'owner') {
      const [own] = await tx
        .select({ id: spaces.id })
        .from(spaces)
        .where(and(eq(spaces.ownerUserId, user.id), eq(spaces.kind, 'personal')))
        .limit(1);
      // A concurrent adoption waits on the row lock, then finds owner_user_id set: no-op.
      const [initial] = own
        ? []
        : await tx
            .select({ id: spaces.id })
            .from(spaces)
            .where(and(isNull(spaces.ownerUserId), eq(spaces.kind, 'personal'), isNull(spaces.archivedAt)))
            .orderBy(spaces.createdAt)
            .limit(1);
      if (initial) {
        await tx
          .update(spaces)
          .set({ ownerUserId: user.id })
          .where(and(eq(spaces.id, initial.id), isNull(spaces.ownerUserId)));
      }
    }
    await tx
      .insert(spaces)
      .values({ name: personalSpaceName(user.name), kind: 'personal', ownerUserId: user.id })
      .onConflictDoNothing({ target: spaces.ownerUserId, where: sql`${spaces.kind} = 'personal'` });
    const [space] = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.ownerUserId, user.id), eq(spaces.kind, 'personal')))
      .limit(1);
    if (!space) return;
    await tx.insert(spaceMembers).values({ spaceId: space.id, userId: user.id, role: 'owner' }).onConflictDoNothing();
    await tx.insert(spaceSettings).values({ spaceId: space.id }).onConflictDoNothing();
    await tx.insert(userPreferences).values({ userId: user.id }).onConflictDoNothing();
  });
}

/**
 * Context of `user` (uncached core; the space/server pair is cached 5 s per process). One query in
 * the common case; creates the personal space when it is missing.
 */
export async function resolveContext(user: CurrentUser): Promise<RequestContext> {
  const cached = scopeCache().get(user.id);
  if (cached && cached.expiresAt > Date.now()) return { user, space: cached.space, environment: cached.environment };

  let scope = await readScope(user.id);
  if (!scope) {
    await ensurePersonalSpace(user);
    scope = await readScope(user.id);
  }
  if (!scope) throw new AppError('INTERNAL', { message: "L'espace de ce compte est introuvable." });
  if (scope.archived) throw new AppError('FORBIDDEN', 'Ce compte est désactivé. Contactez un administrateur.', { reason: 'ACCOUNT_DISABLED' });

  scopeCache().set(user.id, { space: scope.space, environment: scope.environment, expiresAt: Date.now() + CONTEXT_TTL_MS });
  return { user, space: scope.space, environment: scope.environment };
}

/** Memoised per render (layout + page + generateMetadata share it). */
const resolveForRender = cache((user: CurrentUser) => resolveContext(user));

/** Context of the signed-in account, or null when signed out (React cache per request). */
export const getRequestContext = cache(async (): Promise<RequestContext | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  return resolveForRender(user);
});

/** Pages, layouts and server actions: same redirects as `requireUser()`. */
export async function requireContext(): Promise<RequestContext> {
  const user = await requireUser();
  return resolveForRender(user);
}

/** Route handlers: AppError UNAUTHORIZED (401) or FORBIDDEN (403), like `requireUserForApi()`. */
export async function requireContextForApi(): Promise<RequestContext> {
  const user = await requireUserForApi();
  return resolveForRender(user);
}

/**
 * Server of the space and its runner client, for server-level calls (Claude status, metrics,
 * login terminals, new projects). AppError CONFLICT (reason NO_ENVIRONMENT) when none is assigned.
 */
export function requireEnvironment(ctx: Pick<RequestContext, 'environment'>): { environment: EnvironmentRef; runner: RunnerClient } {
  const environment = ctx.environment;
  if (!environment) throw new AppError('CONFLICT', NO_ENVIRONMENT_MESSAGE, { reason: 'NO_ENVIRONMENT' });
  return { environment, runner: getRunnerForEnvironment(environment.id) };
}
