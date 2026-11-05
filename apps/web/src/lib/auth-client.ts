import { passkeyClient } from '@better-auth/passkey/client';
import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * Better Auth client for Client Components — only for what must run in the browser:
 * passkeys (WebAuthn ceremonies). Password, TOTP and backup-code steps go through the server
 * actions of src/app/(auth); account management through src/server/auth/account.ts.
 *
 *   const { error } = await authClient.signIn.passkey();
 *   const { error } = await authClient.passkey.addPasskey({ name: 'Mac · Safari' });
 *   if (error) setMessage(passkeyErrorMessage(error));
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [twoFactorClient(), passkeyClient()],
});

interface ClientError {
  code?: string | undefined;
  message?: string | undefined;
  status?: number | undefined;
}

const PASSKEY_MESSAGES: Record<string, string> = {
  AUTH_CANCELLED: "Connexion par clé d'accès annulée.",
  ERROR_CEREMONY_ABORTED: 'Opération annulée.',
  REGISTRATION_CANCELLED: "Enregistrement de la clé d'accès annulé.",
  ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED: "Cette clé d'accès est déjà enregistrée sur Nuera Dev.",
  PREVIOUSLY_REGISTERED: "Cette clé d'accès est déjà enregistrée sur Nuera Dev.",
  PASSKEY_NOT_FOUND: "Cette clé d'accès n'est pas enregistrée sur Nuera Dev.",
  AUTHENTICATION_FAILED: "Clé d'accès non reconnue.",
  FAILED_TO_VERIFY_REGISTRATION: "La clé d'accès n'a pas pu être vérifiée.",
  CHALLENGE_NOT_FOUND: 'Délai dépassé : recommencez.',
  SESSION_NOT_FRESH: "Par sécurité, reconnectez-vous avant d'ajouter une clé d'accès.",
  TWO_FACTOR_REQUIRED: "Activez d'abord la double authentification.",
  UNAUTHORIZED: 'Connexion requise.',
  ERROR_INVALID_DOMAIN: "Ce domaine ne permet pas les clés d'accès (ouvrez Nuera Dev à son adresse officielle).",
  ERROR_INVALID_RP_ID: "Ce domaine ne permet pas les clés d'accès (ouvrez Nuera Dev à son adresse officielle).",
  ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY: "Votre navigateur a refusé l'opération.",
};

/** French message for an error returned by `authClient` passkey calls. */
export function passkeyErrorMessage(error: ClientError | null | undefined): string {
  if (!error) return "La clé d'accès n'a pas pu être utilisée.";
  if (error.code && PASSKEY_MESSAGES[error.code]) return PASSKEY_MESSAGES[error.code]!;
  if (error.status === 429) return 'Trop de tentatives. Réessayez dans un instant.';
  if (error.status === 401 || error.status === 403) return 'Opération refusée : reconnectez-vous puis réessayez.';
  return "La clé d'accès n'a pas pu être utilisée.";
}

/** True when the browser can use passkeys at all. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
}
