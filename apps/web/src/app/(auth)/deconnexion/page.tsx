import Link from 'next/link';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { describeDevice } from '@/server/auth/device';
import { getCurrentUser } from '@/server/auth/session';
import { headers } from 'next/headers';
import { SubmitButton } from '../_components/submit-button';
import { AuthCard } from '../_components/ui';
import { signOutAction } from './actions';

export const metadata: Metadata = { title: 'Déconnexion' };

/** GET never signs out (CSRF-safe): the POST form below does. */
export default async function DeconnexionPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/connexion');

  const device = describeDevice((await headers()).get('user-agent'));
  return (
    <AuthCard
      title="Se déconnecter"
      description={`Cet appareil (${device.label}) n'aura plus accès à Nuera Dev jusqu'à la prochaine connexion. Les sessions Claude Code continuent sur VPS-3.`}
    >
      <form action={signOutAction} className="flex flex-col gap-4">
        <SubmitButton pendingLabel="Déconnexion…">Se déconnecter</SubmitButton>
        <Link href="/" className="text-app-13 text-muted underline-offset-4 hover:underline">
          Revenir à l'Accueil
        </Link>
      </form>
    </AuthCard>
  );
}
