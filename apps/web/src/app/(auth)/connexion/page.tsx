import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { safeRedirectPath } from '@/server/auth/policy';
import { getCurrentUser } from '@/server/auth/session';
import { getSetupState } from '@/server/auth/setup';
import { AuthCard, FormAlert } from '../_components/ui';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Connexion' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ConnexionPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = safeRedirectPath(Array.isArray(params.suivant) ? params.suivant[0] : params.suivant);

  const user = await getCurrentUser();
  if (user?.twoFactorEnabled) redirect(next);
  if (user) redirect('/configuration/double-facteur');

  const setup = await getSetupState();
  if (setup.kind === 'no_owner') redirect('/configuration');

  return (
    <AuthCard title="Connexion" description="Accès réservé au propriétaire de Nuera Dev.">
      {setup.kind === 'owner_without_2fa' ? (
        <FormAlert tone="info" title="Configuration inachevée">
          La double authentification n'est pas encore activée.{' '}
          <a href="/configuration" className="font-medium text-accent underline underline-offset-4">
            Reprendre la configuration
          </a>
        </FormAlert>
      ) : null}
      <SignInForm next={next} />
    </AuthCard>
  );
}
