import 'server-only';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from '@/server/auth/auth';
import { safeRedirectPath } from '@/server/auth/policy';
import { AppError } from '@/server/errors';
import type { InstanceRole } from '@nuera/db/schema';

/**
 * Current account, for pages, layouts, server actions and route handlers.
 *
 *   const user = await requireUser();          // pages & server actions: redirects when needed
 *   const user = await requireUserForApi();    // route handlers: throws AppError (401 / 403)
 *   const user = await getCurrentUser();       // optional read, null when signed out
 *
 * The session is read from the database on every request (no cookie cache) and the web-session
 * policy (idle / absolute expiry) is enforced by the auth layer before it is returned.
 * `getCurrentUser` is memoised per request (React cache). A disabled account is treated as signed
 * out (its sessions are deleted when it is disabled; this closes the gap for a request in flight).
 * The space and server of the account come from `@/server/tenancy` (`requireContext()`).
 */

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  twoFactorEnabled: boolean;
  /** Id of the Better Auth session row of this request (« Cet appareil » in Accès ouverts). */
  authSessionId: string;
  /** « Propriétaire » · « Administrateur » · « Membre » (docs/MULTICOMPTE.md §2). */
  role: InstanceRole;
  /** Set when an administrator disabled the account (never returned: see getCurrentUser). */
  disabledAt: Date | null;
};

const INSTANCE_ROLES: readonly InstanceRole[] = ['owner', 'admin', 'member'];

/** Role stored by Better Auth (`user.additionalFields`); anything unexpected is the least privileged. */
function toInstanceRole(value: unknown): InstanceRole {
  return INSTANCE_ROLES.includes(value as InstanceRole) ? (value as InstanceRole) : 'member';
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** true for an owner or an administrator of the instance (`apiRoute({ auth: 'admin' })`). */
export function isInstanceAdmin(user: Pick<CurrentUser, 'role'>): boolean {
  return user.role === 'owner' || user.role === 'admin';
}

/** Header set by src/proxy.ts with the requested path, used to come back after sign-in. */
export const REQUEST_PATH_HEADER = 'x-nuera-path';

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const requestHeaders = await headers();
  if (!requestHeaders.get('cookie')) return null;
  const result = await auth.api.getSession({ headers: requestHeaders });
  if (!result) return null;
  const { user, session } = result;
  const extra = user as { twoFactorEnabled?: boolean | null; role?: unknown; disabledAt?: unknown };
  const disabledAt = toDate(extra.disabledAt);
  if (disabledAt) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image ?? null,
    twoFactorEnabled: extra.twoFactorEnabled === true,
    authSessionId: session.id,
    role: toInstanceRole(extra.role),
    disabledAt,
  };
});

/** True when the password step succeeded and the second factor is awaited (cookie `nuera.two_factor`). */
export async function hasPendingSecondFactor(): Promise<boolean> {
  const jar = await cookies();
  return jar.getAll().some(({ name }) => name === 'nuera.two_factor' || name === '__Secure-nuera.two_factor');
}

async function signInUrl(): Promise<string> {
  const requested = (await headers()).get(REQUEST_PATH_HEADER);
  const target = safeRedirectPath(requested, '');
  return target ? `/connexion?suivant=${encodeURIComponent(target)}` : '/connexion';
}

/**
 * Signed-in account with 2FA active (mandatory for every account), or a redirect:
 *  - signed out → /connexion (or /connexion/deux-facteurs when the second factor is pending);
 *  - signed in but 2FA not enrolled yet (setup in progress) → /configuration/double-facteur.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    if (await hasPendingSecondFactor()) redirect('/connexion/deux-facteurs');
    redirect(await signInUrl());
  }
  if (!user.twoFactorEnabled) redirect('/configuration/double-facteur');
  return user;
}

/** For route handlers: AppError UNAUTHORIZED (no session) or FORBIDDEN (2FA not active). */
export async function requireUserForApi(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new AppError('UNAUTHORIZED');
  if (!user.twoFactorEnabled) {
    throw new AppError('FORBIDDEN', 'Activez la double authentification pour continuer.');
  }
  return user;
}

/**
 * Administration pages (`/administration`): owner or administrator with 2FA active. A member gets a
 * 404 — the console is never revealed to someone who cannot use it.
 */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!isInstanceAdmin(user)) notFound();
  return user;
}

/** Route handlers and server actions of the administration: AppError FORBIDDEN for a member. */
export async function requireAdminForApi(): Promise<CurrentUser> {
  const user = await requireUserForApi();
  if (!isInstanceAdmin(user)) throw new AppError('FORBIDDEN', 'Action réservée aux administrateurs.');
  return user;
}
