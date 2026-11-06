import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/server/auth/session';
import { isSetupTokenConfigured } from '@/server/auth/setup-token';
import { getSetupState } from '@/server/auth/setup';
import { AuthCard, FormAlert, SetupProgress } from '../_components/ui';
import { OwnerForm } from './owner-form';
import { ResumeForm } from './resume-form';

export const metadata: Metadata = { title: 'Configuration initiale' };

/**
 * /configuration — exists only while Nuera Dev has no owner with an active 2FA:
 *  - no owner: create the owner account, the first one (SETUP_TOKEN required);
 *  - owner without 2FA (interrupted setup): resume with the token + credentials;
 *  - otherwise: 404.
 */
export default async function ConfigurationPage() {
  const setup = await getSetupState();
  if (setup.kind === 'complete') notFound();

  const user = await getCurrentUser();
  if (user && !user.twoFactorEnabled) redirect('/configuration/double-facteur');

  const tokenConfigured = isSetupTokenConfigured();
  const tokenAlert = tokenConfigured ? null : (
    <FormAlert tone="error" title="Jeton de configuration absent du serveur">
      Renseignez SETUP_TOKEN (16 caractères au moins) dans l'environnement de Nuera Dev, puis rechargez cette page.
    </FormAlert>
  );

  if (setup.kind === 'owner_without_2fa') {
    return (
      <AuthCard
        header={<SetupProgress current={1} />}
        title="Reprendre la configuration"
        description="Le compte propriétaire existe, mais sa double authentification n'est pas encore activée. Saisissez le jeton de configuration et ses identifiants pour la terminer."
      >
        {tokenAlert}
        <ResumeForm disabled={!tokenConfigured} />
      </AuthCard>
    );
  }

  return (
    <AuthCard
      header={<SetupProgress current={1} />}
      title="Créer le compte propriétaire"
      description="Nuera Dev n'a encore aucun compte. Ce premier compte en sera le propriétaire : il invitera les autres. La double authentification sera activée à l'étape suivante."
    >
      {tokenAlert}
      <OwnerForm disabled={!tokenConfigured} />
    </AuthCard>
  );
}
