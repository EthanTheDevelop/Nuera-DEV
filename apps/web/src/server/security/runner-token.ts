import 'server-only';
import { environments } from '@nuera/db/schema';
import type { EnvironmentStatus } from '@nuera/db/schema';
import { hashToken, safeEqual } from '@nuera/shared/tokens';
import { and, eq, or } from 'drizzle-orm';
import { promoteRunnerToken } from '@/server/admin/token-rotation';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { ensureDefaultRunnerTokenHash } from '@/server/runner/config';

/**
 * Runner → web callbacks (/api/internal/*) authenticate with `Authorization: Bearer <jeton du
 * serveur>`; the token designates the calling server (environment):
 *
 * - the default server (`config_source = 'env'`): RUNNER_TOKEN, compared in constant time;
 * - any other server: sha256 of the token looked up in `token_hash` or `next_token_hash` (rotation).
 *
 * A suspended or retired server is refused (403 « Ce serveur est suspendu. »); an unknown token
 * answers 401 « Jeton du runner invalide. ». A token shorter than 16 characters never matches.
 *
 * A callback authenticated by `next_token_hash` proves the runner restarted with the rotated
 * token: it is promoted to `token_*` there and then (MULTICOMPTE §4), and the old one stops working.
 */

const MIN_TOKEN_LENGTH = 16;

/** Server on whose behalf an internal route runs. */
export interface CallerEnvironment {
  id: string;
  name: string;
  /** null: not assigned to a space yet. */
  spaceId: string | null;
  isDefault: boolean;
  status: EnvironmentStatus;
}

/** The token of `Bearer <token>` (exactly one value), or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match?.[1] || null;
}

/** true when `header` is `Bearer <expected>` (constant time over sha256 digests). */
export function isValidRunnerAuthorization(
  header: string | null | undefined,
  expected: string | undefined = process.env.RUNNER_TOKEN,
): boolean {
  const provided = bearerToken(header);
  if (!expected || expected.length < MIN_TOKEN_LENGTH || !provided) return false;
  return safeEqual(provided, expected);
}

const callerColumns = {
  id: environments.id,
  name: environments.name,
  spaceId: environments.spaceId,
  isDefault: environments.isDefault,
  status: environments.status,
};

/**
 * Server designated by the `Authorization` header, or null (→ 401). Throws AppError FORBIDDEN
 * « Ce serveur est suspendu. » for a suspended or retired server.
 */
export async function resolveRunnerCaller(
  header: string | null | undefined,
  expectedDefault: string | undefined = process.env.RUNNER_TOKEN?.trim(),
): Promise<CallerEnvironment | null> {
  const provided = bearerToken(header);
  if (!provided || provided.length < MIN_TOKEN_LENGTH) return null;

  let caller: CallerEnvironment | undefined;
  if (expectedDefault && expectedDefault.length >= MIN_TOKEN_LENGTH && safeEqual(provided, expectedDefault)) {
    await ensureDefaultRunnerTokenHash();
    [caller] = await db
      .select(callerColumns)
      .from(environments)
      .where(and(eq(environments.isDefault, true), eq(environments.configSource, 'env')))
      .limit(1);
  } else {
    const hash = hashToken(provided);
    const [row] = await db
      .select({ ...callerColumns, nextTokenHash: environments.nextTokenHash })
      .from(environments)
      .where(and(eq(environments.configSource, 'db'), or(eq(environments.tokenHash, hash), eq(environments.nextTokenHash, hash))))
      .limit(1);
    if (row) {
      const { nextTokenHash, ...rest } = row;
      caller = rest;
      if (nextTokenHash === hash && rest.status !== 'suspended' && rest.status !== 'retired') {
        await promoteRunnerToken(rest.id, hash);
      }
    }
  }
  if (!caller) return null;
  if (caller.status === 'suspended' || caller.status === 'retired') {
    throw new AppError('FORBIDDEN', 'Ce serveur est suspendu.', { reason: 'ENVIRONMENT_DISABLED' });
  }
  return caller;
}
