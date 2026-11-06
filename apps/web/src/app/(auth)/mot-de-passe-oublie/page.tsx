import Link from 'next/link';
import type { Metadata } from 'next';
import { isMailConfigured } from '@/server/mail';
import { AuthCard, FormAlert } from '../_components/ui';
import { ForgotPasswordForm } from './forgot-form';

export const metadata: Metadata = { title: 'Mot de passe oublié' };
export const dynamic = 'force-dynamic';

const linkClass = 'text-app-13 font-medium text-accent underline underline-offset-4';

/** /mot-de-passe-oublie — demande d'un lien de réinitialisation par e-mail. */
export default function MotDePasseOubliePage() {
  return (
    <AuthCard
      title="Mot de passe oublié"
      description="Saisissez l'e-mail de votre compte : vous recevrez un lien pour choisir un nouveau mot de passe."
    >
      {isMailConfigured() ? (
        <ForgotPasswordForm />
      ) : (
        <FormAlert tone="info" title="L'envoi d'e-mails n'est pas configuré sur ce serveur">
          Demandez un lien de récupération à un administrateur de Nuera Dev.
        </FormAlert>
      )}
      <Link href="/connexion" className={linkClass}>
        Retour à la connexion
      </Link>
    </AuthCard>
  );
}
