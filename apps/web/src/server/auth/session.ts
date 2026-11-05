import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from '@/server/auth/auth';
import { safeRedirectPath } from '@/server/auth/policy';
import { AppError } from '@/server/errors';

/**
 * Current owner, for pages, layouts, server actions and route handlers.
 *
 *   const user = await requireUser();          // pages & server actions: redirects when needed
 *   const user = await requireUserForApi();    // route handlers: throws AppError (401 / 403)
 *   const user = await getCurrentUser();       // optional read, null when signed out
 *
 * The session is read from the database on every request (no cookie cache) and the web-session
 * policy (idle / absolute expiry) is enforced by the auth layer before it is returned.
 * `getCurrentUser` is memoised per request (React cache).
 */

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  twoFactorEnabled: boolean;
  /** Id of the Better Auth session row of this request (« Cet appareil » in Accès ouverts). */
  authSessionId: string;
};

/** Header set by src/proxy.ts with the requested path, used to come back after sign-in. */
export const REQUEST_PATH_HEADER = 'x-nuera-path';

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const requestHeaders = await headers();
  if (!requestHeaders.get('cookie')) return null;
  const result = await auth.api.getSession({ headers: requestHeaders });
  if (!result) return null;
  const { user, session } = result;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image ?? null,
    twoFactorEnabled: (user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled === true,
    authSessionId: session.id,
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
 * Owner with 2FA active, or a redirect:
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
