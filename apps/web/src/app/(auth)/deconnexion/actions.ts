'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/server/auth/auth';
import { checkOrigin } from '@/server/security/origin';

/**
 * Signs the current device out (session deleted, cookies cleared) and goes back to /connexion.
 * Usable from any page: `<form action={signOutAction}><button type="submit">Se déconnecter</button></form>`.
 */
export async function signOutAction(): Promise<void> {
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
  redirect('/connexion');
}
