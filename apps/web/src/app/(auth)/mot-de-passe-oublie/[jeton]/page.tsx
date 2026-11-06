import type { Metadata } from 'next';
import { getPasswordResetState } from '@/server/auth/password-reset';
import { NewPasswordForm } from '../../_components/link-forms';
import { decodeLinkToken, UnusableLink } from '../../_components/link-states';
import { AuthCard } from '../../_components/ui';
import { resetPasswordAction } from './actions';

/** Le lien porte un secret : jamais envoyé en Referer, jamais indexé. */
export const metadata: Metadata = { title: 'Nouveau mot de passe', referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';

type Params = Promise<{ jeton: string }>;

/** /mot-de-passe-oublie/<jeton> — lien reçu par e-mail : choix d'un nouveau mot de passe. */
export default async function NouveauMotDePassePage({ params }: { params: Params }) {
  const { jeton } = await params;
  const token = decodeLinkToken(jeton);
  const state = await getPasswordResetState(token);

  if (state.kind === 'invalid') {
    return (
      <UnusableLink title="Ce lien n'est pas valide">
        Il a été mal copié, a déjà servi ou a été remplacé par une demande plus récente. Faites une nouvelle demande depuis la page
        de connexion.
      </UnusableLink>
    );
  }
  if (state.kind === 'expired') {
    return (
      <UnusableLink title="Ce lien a expiré">
        Pour votre sécurité, un lien de réinitialisation n'est valable que 30 minutes. Faites une nouvelle demande depuis la page
        de connexion.
      </UnusableLink>
    );
  }
  return (
    <AuthCard
      title="Choisir un nouveau mot de passe"
      description="Vos accès web ouverts seront fermés. La double authentification reste demandée à la connexion."
    >
      <NewPasswordForm
        action={resetPasswordAction.bind(null, token)}
        email={state.email}
        withName={false}
        submitLabel="Choisir ce mot de passe"
        pendingLabel="Enregistrement…"
      />
    </AuthCard>
  );
}
