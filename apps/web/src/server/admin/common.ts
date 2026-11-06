import 'server-only';
import { account } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { getAuthContext } from '@/server/auth/auth';
import type { CurrentUser } from '@/server/auth/session';
import { isInstanceAdmin } from '@/server/auth/session';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { assertRateLimit, AUTH_RATE_LIMITS } from '@/server/security/rate-limit';

/**
 * Shared pieces of the administration (docs/MULTICOMPTE.md §6, §10): every function of
 * server/admin/** takes the acting administrator (`requireAdminForApi()` / `apiRoute({ auth: 'admin' })`
 * resolved it) and re-checks the role itself, so that no caller can skip it. Mutations are rate
 * limited per administrator (30 / 10 min) and journaled (`admin.*`, instance journal); they never
 * read nor write the content of a space (projects, sessions, Git…).
 */

export type AdminActor = Pick<CurrentUser, 'id' | 'name' | 'email' | 'role'>;

export const NOT_FOUND_ACCOUNT = 'Compte introuvable.';
export const NOT_FOUND_SERVER = 'Serveur introuvable.';
export const NOT_FOUND_INVITATION = 'Invitation introuvable.';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertAdmin(actor: AdminActor): void {
  if (!isInstanceAdmin(actor))
    throw new AppError('FORBIDDEN', 'Action réservée aux administrateurs.');
}

/** Role check + the per-administrator rate limit of every mutation. */
export function assertAdminMutation(actor: AdminActor): void {
  assertAdmin(actor);
  assertRateLimit('admin:mutation', actor.id, AUTH_RATE_LIMITS.adminMutation);
}

export const iso = (date: Date | null | undefined): string | null =>
  date ? date.toISOString() : null;

/** French refusal of a wrong password re-entered by an administrator. */
export const WRONG_PASSWORD = 'Votre mot de passe est incorrect.';

/**
 * The administrator's own password, asked again before an action that reaches another account
 * (recovery link, new address of another account's server). Rate limited per administrator.
 */
export async function verifyOwnPassword(actor: AdminActor, password: string): Promise<void> {
  assertRateLimit('admin:reconfirm', actor.id, AUTH_RATE_LIMITS.sensitive);
  const [credential] = await db
    .select({ hash: account.password })
    .from(account)
    .where(and(eq(account.userId, actor.id), eq(account.providerId, 'credential')))
    .limit(1);
  const context = await getAuthContext();
  const ok = credential?.hash
    ? await context.password.verify({ hash: credential.hash, password })
    : false;
  if (!ok) throw new AppError('FORBIDDEN', WRONG_PASSWORD);
}
