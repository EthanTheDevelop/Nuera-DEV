import 'server-only';
import { isAPIError } from 'better-auth/api';

/**
 * French messages for Better Auth error codes surfaced by the auth server actions.
 * (Client-side passkey errors are translated in src/lib/auth-client.ts.)
 */
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'E-mail ou mot de passe incorrect.',
  INVALID_EMAIL: 'Adresse e-mail invalide.',
  INVALID_PASSWORD: 'Mot de passe incorrect.',
  PASSWORD_TOO_SHORT: 'Mot de passe trop court : 12 caractères au minimum.',
  PASSWORD_TOO_LONG: 'Mot de passe trop long : 128 caractères au maximum.',
  CREDENTIAL_ACCOUNT_NOT_FOUND: "Aucun mot de passe n'est enregistré pour ce compte.",
  INVALID_CODE: "Code incorrect. Vérifiez l'heure de votre téléphone, puis saisissez le code affiché.",
  INVALID_BACKUP_CODE: 'Code de secours inconnu ou déjà utilisé.',
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "Trop d'essais pour cette connexion : recommencez avec votre mot de passe.",
  ACCOUNT_TEMPORARILY_LOCKED: "Trop d'échecs : la double authentification est bloquée pendant 15 minutes.",
  INVALID_TWO_FACTOR_COOKIE: 'Cette étape a expiré : recommencez avec votre mot de passe.',
  TOTP_NOT_ENABLED: "La double authentification n'est pas encore activée.",
  TOTP_ALREADY_ENABLED: 'La double authentification est déjà active.',
  TWO_FACTOR_NOT_ENABLED: "La double authentification n'est pas activée.",
  BACKUP_CODES_NOT_ENABLED: "Aucun code de secours n'est enregistré.",
  SESSION_NOT_FRESH: 'Par sécurité, reconnectez-vous avant cette action.',
  SESSION_EXPIRED: 'Votre accès a expiré : reconnectez-vous.',
  UNAUTHORIZED: 'Connexion requise.',
  SETUP_INCOMPLETE: 'Configuration inachevée : terminez-la depuis la page de configuration, avec le jeton.',
  TWO_FACTOR_REQUIRED: 'La double authentification est obligatoire sur Nuera Dev.',
  PASSKEY_NOT_FOUND: "Cette clé d'accès n'est pas enregistrée sur Nuera Dev.",
  FAILED_TO_CREATE_SESSION: "Impossible d'ouvrir la session. Réessayez.",
  USER_ALREADY_EXISTS: 'Nuera Dev a déjà un propriétaire.',
  OWNER_ALREADY_EXISTS: 'Nuera Dev a déjà un propriétaire.',
};

export function authErrorCode(error: unknown): string | null {
  if (!isAPIError(error)) return null;
  const body = error.body as { code?: unknown } | undefined;
  return typeof body?.code === 'string' ? body.code : null;
}

/** French message for a Better Auth APIError (fallback: generic message, never the English text). */
export function authErrorMessage(error: unknown, fallback = 'La vérification a échoué. Réessayez.'): string {
  if (isAPIError(error)) {
    const code = authErrorCode(error);
    if (code && MESSAGES[code]) return MESSAGES[code];
    if (error.statusCode === 429) return 'Trop de tentatives. Réessayez dans un instant.';
  }
  return fallback;
}
