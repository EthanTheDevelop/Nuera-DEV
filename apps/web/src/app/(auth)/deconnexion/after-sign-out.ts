import { safeRedirectPath } from '@/server/auth/policy';

/**
 * Where a sign-out goes: /connexion, carrying `suivant` when the page that asked for it wants the
 * next account back there (« Se déconnecter » of the notification click guard). `suivant` is
 * validated as an in-app path (`safeRedirectPath`: never another origin, never an auth page).
 *
 *   redirect(signInAfterSignOut(formData.get('suivant')));  // → /connexion?suivant=%2Fparametres%2Fnotification%3F…
 */
export function signInAfterSignOut(next: unknown): string {
  const target = safeRedirectPath(Array.isArray(next) ? next[0] : next);
  return target === '/' ? '/connexion' : `/connexion?suivant=${encodeURIComponent(target)}`;
}
