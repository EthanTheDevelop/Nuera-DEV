'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/server/auth/auth';
import { getCurrentUser } from '@/server/auth/session';
import { deleteSubscription, deleteSubscriptionsForSession, pushEndpointSchema } from '@/server/push';
import { checkOrigin } from '@/server/security/origin';
import { signInAfterSignOut } from './after-sign-out';

/**
 * Signs the current device out (session deleted, cookies cleared) and goes back to /connexion.
 * Usable from any page: `<form action={signOutAction}><button type="submit">Se déconnecter</button></form>`.
 *
 * The device stops receiving this account's notifications (docs/MULTICOMPTE.md §9): the form posts
 * the push endpoint of this browser (`pushEndpoint`, read from the service worker's pushManager by
 * SignOutForm) and its subscription is deleted for this account; the subscriptions registered by
 * this access are deleted as well (a form posted without JavaScript has no endpoint).
 *
 * `suivant` (optional, validated as an in-app path): /connexion comes back there after the next
 * sign-in (« Se déconnecter » of the notification click guard).
 */
export async function signOutAction(formData?: FormData): Promise<void> {
  const requestHeaders = await headers();
  const origin = checkOrigin({
    method: 'POST',
    origin: requestHeaders.get('origin'),
    referer: requestHeaders.get('referer'),
    host: requestHeaders.get('host'),
    secFetchSite: requestHeaders.get('sec-fetch-site'),
    appUrl: process.env.APP_URL,
    isProduction: process.env.NODE_ENV === 'production',
  });
  if (!origin.ok) redirect('/');

  const current = await getCurrentUser().catch(() => null);
  if (current) {
    try {
      const endpoint = pushEndpointSchema.safeParse(formData?.get('pushEndpoint'));
      if (endpoint.success) await deleteSubscription(current.id, endpoint.data);
      await deleteSubscriptionsForSession(current.authSessionId);
    } catch (error) {
      console.warn('[auth] abonnement push non retiré à la déconnexion', error instanceof Error ? error.message : error);
    }
  }

  try {
    await auth.api.signOut({ headers: requestHeaders });
  } catch (error) {
    // Already signed out (expired session): clear the session cookies ourselves.
    console.warn('[auth] déconnexion', error instanceof Error ? error.message : error);
    const jar = await cookies();
    for (const { name } of jar.getAll()) {
      if (/^(__Secure-)?nuera\.(session_token|session_data|dont_remember|two_factor)$/.test(name)) jar.delete(name);
    }
  }
  redirect(signInAfterSignOut(formData?.get('suivant')));
}
