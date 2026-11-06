import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { describeDevice } from '@/server/auth/device';
import { getCurrentUser } from '@/server/auth/session';
import { isSetupCompleted } from '@/server/auth/setup';
import { AuthCard, SetupProgress } from '../../_components/ui';
import { PasskeyStep } from './passkey-step';

export const metadata: Metadata = { title: "Clé d'accès · Configuration" };

export default async function CleDAccesPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/connexion');
  if (!user.twoFactorEnabled) redirect('/configuration/double-facteur');
  if (await isSetupCompleted(user.id)) redirect('/');

  const device = describeDevice((await headers()).get('user-agent'));
  return (
    <AuthCard
      header={<SetupProgress current={4} activation={user.role !== 'owner'} />}
      title="Clé d'accès (facultatif)"
      description="Sur cet appareil, une clé d'accès (Face ID, Touch ID, Windows Hello ou clé de sécurité) remplace le mot de passe et le code en une seule étape. Vous pourrez en ajouter plus tard depuis Paramètres."
    >
      <PasskeyStep suggestedName={device.label} activation={user.role !== 'owner'} />
    </AuthCard>
  );
}
