import Link from 'next/link';
import type { ReactNode } from 'react';
import { AuthCard, FormAlert } from './ui';

/** The token of a /invitation/<jeton> or /recuperation/<jeton> segment (an undecodable one is just unknown). */
export function decodeLinkToken(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

/** « 48 h », « 7 jours ». */
export function formatValidity(hours: number): string {
  return hours >= 72 && hours % 24 === 0 ? `${hours / 24} jours` : `${hours} h`;
}

const linkClass = 'flex min-h-11 items-center self-start text-app-14 font-medium text-accent underline-offset-4 hover:underline';

/** A link that cannot be used (unknown, revoked, expired, already used): explained, never the form. */
export function UnusableLink({ title, children, signIn = true }: { title: string; children: ReactNode; signIn?: boolean }) {
  return (
    <AuthCard title={title} description={children}>
      {signIn ? (
        <Link href="/connexion" className={linkClass}>
          Se connecter
        </Link>
      ) : null}
    </AuthCard>
  );
}

/** Another account is signed in on this browser: it must sign out first (one account per browser profile). */
export function OtherAccountSignedIn({ message, currentEmail }: { message: string; currentEmail: string }) {
  return (
    <AuthCard title="Vous êtes déjà connecté" description={`Cet appareil est connecté au compte ${currentEmail}.`}>
      <FormAlert tone="info" title={message}>
        Pour garder les deux comptes ouverts, utilisez un autre profil du navigateur ou une fenêtre privée.
      </FormAlert>
      <Link href="/deconnexion" className={linkClass}>
        Se déconnecter
      </Link>
    </AuthCard>
  );
}
