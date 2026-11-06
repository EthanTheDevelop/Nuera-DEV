import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/server/auth/session';
import { getSetupBackupCodes, hasAcknowledgedCodes, isSetupCompleted } from '@/server/auth/setup';
import { AuthCard, SetupProgress } from '../../_components/ui';
import { BackupCodesPanel } from './backup-codes-panel';

export const metadata: Metadata = { title: 'Codes de secours · Configuration' };

/** Shown once, during the setup only: afterwards codes are regenerated from Paramètres. */
export default async function CodesDeSecoursPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/connexion');
  if (!user.twoFactorEnabled) redirect('/configuration/double-facteur');
  if (await hasAcknowledgedCodes(user.id)) {
    redirect((await isSetupCompleted(user.id)) ? '/' : '/configuration/cle-d-acces');
  }

  const codes = await getSetupBackupCodes(user.id);
  return (
    <AuthCard
      header={<SetupProgress current={3} activation={user.role !== 'owner'} />}
      title="Codes de secours"
      description="Si vous perdez votre téléphone, chaque code permet une seule connexion à la place de l'application. Conservez-les hors de cet appareil, par exemple dans votre gestionnaire de mots de passe."
    >
      <BackupCodesPanel codes={codes} account={user.email} />
    </AuthCard>
  );
}
