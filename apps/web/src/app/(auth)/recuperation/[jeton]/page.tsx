import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getLinkState, LINK_COPY } from '@/server/auth/links';
import { getCurrentUser } from '@/server/auth/session';
import { NewPasswordForm, ResumeLinkForm } from '../../_components/link-forms';
import { decodeLinkToken, formatValidity, OtherAccountSignedIn, UnusableLink } from '../../_components/link-states';
import { AuthCard, SetupProgress } from '../../_components/ui';
import { recoverAccountAction, resumeRecoveryAction } from './actions';

/** The link carries a secret: never sent as a Referer, never indexed. */
export const metadata: Metadata = { title: 'Récupération du compte', referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';

type Params = Promise<{ jeton: string }>;

/**
 * /recuperation/<jeton> — docs/MULTICOMPTE.md §6. A single-use link created by an administrator (or
 * the break-glass command line): new password, then the same activation steps (new TOTP key, new
 * backup codes, passkey). The accesses, trusted devices and second factor of the account were closed
 * when the link was created.
 */
export default async function RecuperationPage({ params }: { params: Params }) {
  const { jeton } = await params;
  const token = decodeLinkToken(jeton);
  const current = await getCurrentUser();
  const state = await getLinkState('recovery', token, current);

  switch (state.kind) {
    case 'continue':
      redirect('/configuration/double-facteur');
    case 'invalid':
      return (
        <UnusableLink title="Ce lien n'est pas valide">
          Il a été mal copié, ou il n'existe plus. Demandez un nouveau lien de récupération à un administrateur de Nuera Dev.
        </UnusableLink>
      );
    case 'revoked':
      return (
        <UnusableLink title="Ce lien de récupération a été annulé">
          Un lien plus récent l'a remplacé. Utilisez le dernier lien reçu, ou demandez-en un nouveau à un administrateur.
        </UnusableLink>
      );
    case 'expired':
      return (
        <UnusableLink title="Ce lien a expiré">
          Pour votre sécurité, un lien de récupération n'est valable que {formatValidity(state.validityHours)}. Demandez-en un nouveau
          à un administrateur.
        </UnusableLink>
      );
    case 'used':
      return (
        <UnusableLink title="Ce lien a déjà servi">
          Le compte {state.email} a retrouvé son accès : connectez-vous avec son mot de passe et son code.
        </UnusableLink>
      );
    case 'signed_in_other':
      return <OtherAccountSignedIn message={LINK_COPY.otherAccountSignedInRecovery} currentEmail={state.currentEmail} />;
    case 'resume':
      return (
        <AuthCard
          header={<SetupProgress current={1} activation />}
          title="Reprendre l'activation"
          description={`Le nouveau mot de passe du compte ${state.email} est enregistré, mais sa double authentification n'est pas encore activée. Saisissez ce mot de passe pour la terminer.`}
        >
          <ResumeLinkForm action={resumeRecoveryAction.bind(null, token)} email={state.email} />
        </AuthCard>
      );
    case 'valid':
      return (
        <AuthCard
          header={<SetupProgress current={1} activation />}
          title="Récupérer votre compte"
          description="Choisissez un nouveau mot de passe, puis réactivez la double authentification avec votre application."
        >
          <NewPasswordForm
            action={recoverAccountAction.bind(null, token)}
            email={state.email}
            withName={false}
            submitLabel="Choisir ce mot de passe"
            pendingLabel="Enregistrement…"
          />
        </AuthCard>
      );
  }
}
