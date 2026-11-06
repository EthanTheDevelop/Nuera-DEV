import Link from 'next/link';
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
    <AuthCard title="Connexion" description="Accès réservé aux comptes de Nuera Dev.">
      {setup.kind === 'owner_without_2fa' ? (
        <FormAlert tone="info" title="Configuration inachevée">
          La double authentification du compte propriétaire n'est pas encore activée.{' '}
          <Link href="/configuration" className="font-medium text-accent underline underline-offset-4">
            Reprendre la configuration
          </Link>
        </FormAlert>
      ) : null}
      <SignInForm next={next} />
      <div className="flex flex-col gap-1.5 border-t border-border pt-4 text-app-12 leading-4 text-muted">
        <p>Pas de compte ? Demandez une invitation à un administrateur de Nuera Dev.</p>
        <p>
          Pour utiliser deux comptes en même temps sur cet appareil, ouvrez le second dans un autre profil du navigateur ou une
          fenêtre privée.
        </p>
      </div>
    </AuthCard>
  );
}
