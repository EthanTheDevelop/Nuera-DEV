import { z } from 'zod';

/**
 * Password rules for the owner account (setup and password change).
 * Shown to the user as: « 12 caractères au minimum, lettres et chiffres ou symboles ».
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_RULES_TEXT = '12 caractères au minimum, avec des lettres et au moins un chiffre ou un symbole.';

const PREDICTABLE = [
  'password',
  'motdepasse',
  'azerty',
  'qwerty',
  '123456',
  'nuera',
  'nueradev',
  'admin',
  'letmein',
  'bonjour',
  'soleil',
];

export interface PasswordContext {
  email?: string | null;
  name?: string | null;
}

/** Returns the French reasons why a password is refused (empty array = acceptable). */
export function passwordProblems(password: string, context: PasswordContext = {}): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`${PASSWORD_MIN_LENGTH} caractères au minimum`);
  if (password.length > PASSWORD_MAX_LENGTH) problems.push(`${PASSWORD_MAX_LENGTH} caractères au maximum`);
  if (!/\p{L}/u.test(password) || !/[^\p{L}\s]/u.test(password)) {
    problems.push('des lettres et au moins un chiffre ou un symbole');
  }
  if (/^(.)\1+$/u.test(password)) problems.push('pas un seul caractère répété');

  const lowered = password.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const compact = lowered.replace(/[^a-z0-9]/g, '');
  const emailLocal = context.email?.toLowerCase().split('@')[0]?.replace(/[^a-z0-9]/g, '') ?? '';
  const nameCompact = context.name?.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '') ?? '';
  if (
    (emailLocal.length >= 4 && compact.includes(emailLocal)) ||
    (nameCompact.length >= 4 && compact.includes(nameCompact))
  ) {
    problems.push('sans votre nom ni votre e-mail');
  }
  const stripped = compact.replace(/[0-9]+$/, '');
  if (PREDICTABLE.some((word) => stripped === word || stripped === `${word}${word}`)) {
    problems.push('pas un mot de passe courant');
  }
  return problems;
}

/** Zod schema for a new password (context-free rules; call `passwordProblems` for name/e-mail checks). */
export const newPasswordSchema = z
  .string('mot de passe requis')
  .max(PASSWORD_MAX_LENGTH, `${PASSWORD_MAX_LENGTH} caractères au maximum`)
  .superRefine((value, ctx) => {
    for (const message of passwordProblems(value)) ctx.addIssue({ code: 'custom', message });
  });
