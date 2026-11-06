import { safeRedirectPath } from '@/server/auth/policy';

const GUARD_PATH = '/parametres/notification';

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/**
 * « Se déconnecter » of the notification click guard: /deconnexion?suivant=<this guard, same
 * `vers` and `compte`>, so that once the right account has signed in, /connexion brings it back
 * here and the notification opens (W5). Only `vers` and `compte` are carried; a guard URL that is
 * not a valid in-app path (too long…) signs out to plain /connexion.
 */
export function guardSignOutHref(params: { vers?: string | string[]; compte?: string | string[] }): string {
  const query = new URLSearchParams();
  const vers = first(params.vers);
  const compte = first(params.compte);
  if (vers) query.set('vers', vers);
  if (compte) query.set('compte', compte);
  const search = query.toString();
  const guard = search ? `${GUARD_PATH}?${search}` : GUARD_PATH;
  const next = safeRedirectPath(guard);
  return next === '/' ? '/deconnexion' : `/deconnexion?suivant=${encodeURIComponent(next)}`;
}
