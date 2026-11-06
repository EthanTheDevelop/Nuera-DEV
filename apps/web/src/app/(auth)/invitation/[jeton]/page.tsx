import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getLinkState, LINK_COPY } from '@/server/auth/links';
import { getCurrentUser } from '@/server/auth/session';
import { NewPasswordForm, ResumeLinkForm } from '../../_components/link-forms';
import { decodeLinkToken, formatValidity, OtherAccountSignedIn, UnusableLink } from '../../_components/link-states';
import { AuthCard, SetupProgress } from '../../_components/ui';
import { acceptInvitationAction, resumeInvitationAction } from './actions';

/** The link carries a secret: never sent as a Referer, never indexed. */
export const metadata: Metadata = { title: 'Invitation', referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';

type Params = Promise<{ jeton: string }>;

/**
 * /invitation/<jeton> — docs/MULTICOMPTE.md §6. Valid link: name + password (the invited e-mail is
 * read-only), then « Activation de votre compte » (TOTP → codes de secours → clé d'accès). An
 * activation in progress resumes here with the password chosen, until the second factor is enrolled.
 * Unknown, revoked, expired or used links are explained without the form.
 */
export default async function InvitationPage({ params }: { params: Params }) {
  const { jeton } = await params;
  const token = decodeLinkToken(jeton);
  const current = await getCurrentUser();
  const state = await getLinkState('invite', token, current);

  switch (state.kind) {
    case 'continue':
      redirect('/configuration/double-facteur');
    case 'invalid':
      return (
        <UnusableLink title="Ce lien n'est pas valide">
          Il a été mal copié, ou il n'existe plus. Demandez un nouveau lien à un administrateur de Nuera Dev.
        </UnusableLink>
      );
    case 'revoked':
      return (
        <UnusableLink title="Cette invitation a été annulée">
          Demandez-en une nouvelle à un administrateur de Nuera Dev.
        </UnusableLink>
      );
    case 'expired':
      return (
        <UnusableLink title="Ce lien a expiré">
          Pour votre sécurité, une invitation n'est valable que {formatValidity(state.validityHours)}. Demandez-en une nouvelle à la
          personne qui vous a invité.
        </UnusableLink>
      );
    case 'used':
      return (
        <UnusableLink title="Cette invitation a déjà servi">
          Le compte {state.email} existe déjà : connectez-vous avec son mot de passe et son code.
        </UnusableLink>
      );
    case 'signed_in_other':
      return <OtherAccountSignedIn message={LINK_COPY.otherAccountSignedIn} currentEmail={state.currentEmail} />;
    case 'resume':
      return (
        <AuthCard
          header={<SetupProgress current={1} activation />}
          title="Reprendre l'activation"
          description={`Le compte ${state.email} existe, mais sa double authentification n'est pas encore activée. Saisissez le mot de passe choisi pour la terminer.`}
        >
          <ResumeLinkForm action={resumeInvitationAction.bind(null, token)} email={state.email} />
        </AuthCard>
      );
    case 'valid': {
      const inviter = state.inviterName?.trim().split(/\s+/)[0] ?? null;
      const intro = inviter ? `${inviter} vous invite sur Nuera Dev` : 'Vous êtes invité sur Nuera Dev';
      return (
        <AuthCard
          header={<SetupProgress current={1} activation />}
          title="Rejoindre Nuera Dev"
          description={`${intro}${state.serverName ? ` : vous travaillerez sur le serveur ${state.serverName}` : ''}. La double authentification sera activée à l'étape suivante.`}
        >
          <NewPasswordForm
            action={acceptInvitationAction.bind(null, token)}
            email={state.email}
            withName
            submitLabel="Créer mon compte"
            pendingLabel="Création du compte…"
          />
        </AuthCard>
      );
    }
  }
}
