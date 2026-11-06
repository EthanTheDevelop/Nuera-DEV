import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { describeDevice } from '@/server/auth/device';
import { safeRedirectPath } from '@/server/auth/policy';
import { getCurrentUser } from '@/server/auth/session';
import { getRequestContext } from '@/server/tenancy/context';
import { AuthCard } from '../_components/ui';
import { signInAfterSignOut } from './after-sign-out';
import { SignOutForm } from './sign-out-form';

export const metadata: Metadata = { title: 'Déconnexion' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * GET never signs out (CSRF-safe): the POST form below does. `suivant` (in-app path, validated):
 * where /connexion goes once the next account has signed in (notification click guard).
 */
export default async function DeconnexionPage({ searchParams }: { searchParams: SearchParams }) {
  const { suivant } = await searchParams;
  const next = safeRedirectPath(Array.isArray(suivant) ? suivant[0] : suivant);
  const user = await getCurrentUser();
  if (!user) redirect(signInAfterSignOut(next));

  const device = describeDevice((await headers()).get('user-agent'));
  // The account's server, when it has one (an account still in its activation has no context yet).
  const server = user.twoFactorEnabled ? ((await getRequestContext().catch(() => null))?.environment?.name ?? null) : null;
  return (
    <AuthCard
      title="Se déconnecter"
      description={`Cet appareil (${device.label}) n'aura plus accès à Nuera Dev jusqu'à la prochaine connexion.${
        server ? ` Les sessions Claude Code continuent sur ${server}.` : ''
      }`}
    >
      <SignOutForm next={next === '/' ? null : next} />
    </AuthCard>
  );
}
