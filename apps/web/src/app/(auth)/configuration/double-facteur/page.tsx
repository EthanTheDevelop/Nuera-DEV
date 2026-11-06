import Link from 'next/link';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { twoFactorRequired } from '@/server/auth/policy';
import { getCurrentUser } from '@/server/auth/session';
import { getPendingEnrolment, getSetupState } from '@/server/auth/setup';
import { AuthCard, SetupProgress } from '../../_components/ui';
import { EnrolmentForm } from './enrolment-form';
import { RestartEnrolmentForm } from './restart-form';

export const metadata: Metadata = { title: 'Double authentification · Configuration' };

export default async function DoubleFacteurPage() {
  const user = await getCurrentUser();
  if (!user) {
    const setup = await getSetupState();
    redirect(setup.kind === 'complete' ? '/connexion' : '/configuration');
  }
  if (user.twoFactorEnabled) redirect('/configuration/codes-de-secours');

  const pending = await getPendingEnrolment(user);
  const required = twoFactorRequired();
  return (
    <AuthCard
      header={<SetupProgress current={2} activation={user.role !== 'owner'} />}
      title="Double authentification"
      description={
        required
          ? "Obligatoire sur Nuera Dev : chaque connexion demandera, après le mot de passe, le code de votre application d'authentification."
          : "Recommandée : une fois activée, chaque connexion demandera, après le mot de passe, le code de votre application d'authentification."
      }
    >
      {pending ? (
        <EnrolmentForm otpauthUri={pending.otpauthUri} manualKey={pending.manualKey} />
      ) : (
        <RestartEnrolmentForm />
      )}
      {required ? null : (
        <Link href="/" className="self-start text-app-13 font-medium text-accent underline underline-offset-4">
          Passer cette étape
        </Link>
      )}
    </AuthCard>
  );
}
