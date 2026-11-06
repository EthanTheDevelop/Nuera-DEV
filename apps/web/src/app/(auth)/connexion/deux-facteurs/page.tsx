import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { safeRedirectPath } from '@/server/auth/policy';
import { getCurrentUser, hasPendingSecondFactor } from '@/server/auth/session';
import { AuthCard } from '../../_components/ui';
import { SecondFactorForm } from './second-factor-form';
import { twoFactorRequired } from '@/server/auth/policy';

export const metadata: Metadata = { title: 'Double authentification' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DeuxFacteursPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = safeRedirectPath(Array.isArray(params.suivant) ? params.suivant[0] : params.suivant);

  const user = await getCurrentUser();
  if (user && (user.twoFactorEnabled || !twoFactorRequired())) redirect(next);
  if (!(await hasPendingSecondFactor())) redirect(next === '/' ? '/connexion' : `/connexion?suivant=${encodeURIComponent(next)}`);

  return (
    <AuthCard
      title="Double authentification"
      description="Mot de passe accepté. Confirmez qu'il s'agit bien de vous avec votre application d'authentification."
    >
      <SecondFactorForm next={next} />
    </AuthCard>
  );
}
