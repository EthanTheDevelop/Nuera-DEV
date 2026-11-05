import 'server-only';
import { account, auditLog, twoFactor, user } from '@nuera/db/schema';
import { isAPIError } from 'better-auth/api';
import { symmetricDecrypt } from 'better-auth/crypto';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { auth, getAuthContext } from '@/server/auth/auth';
import { authErrorCode, authErrorMessage } from '@/server/auth/messages';
import { passwordProblems, PASSWORD_MAX_LENGTH } from '@/server/auth/password-policy';
import { checkSetupToken } from '@/server/auth/setup-token';
import { issueSetupNonce, SETUP_NONCE_HEADER } from '@/server/auth/setup-nonce';
import { buildOtpAuthUri, groupSecret, normaliseTotpCode, totpSecretToBase32 } from '@/server/auth/totp';
import { AppError, formatZodIssues } from '@/server/errors';
import { audit, AUDIT_ACTIONS } from '@/server/security/audit';
import { assertRateLimit, AUTH_RATE_LIMITS } from '@/server/security/rate-limit';
import { getClientIp } from '@/server/security/request-info';

/**
 * Owner setup (/configuration): SETUP_TOKEN → owner account → mandatory TOTP enrolment →
 * backup codes acknowledged → optional passkey → done.
 *
 * Progress facts live in `audit_log` (append-only): `auth.setup_codes_acknowledged`,
 * `auth.setup_completed`, tied to the TOTP enrolment they belong to (`metadata.twoFactorId`), so
 * that a setup resumed after a 2FA reset (docs/SECURITY.md §8) shows the new backup codes again.
 * While the owner has no 2FA, password sign-in is refused everywhere except through this
 * token-gated flow (see nuera-plugin.ts).
 */

export const SETUP_ACTIONS = {
  codesAcknowledged: 'auth.setup_codes_acknowledged',
  completed: 'auth.setup_completed',
} as const;

export type SetupState =
  | { kind: 'no_owner' }
  | { kind: 'owner_without_2fa'; ownerId: string }
  | { kind: 'complete'; ownerId: string };

export async function getSetupState(): Promise<SetupState> {
  const [owner] = await db.select({ id: user.id, twoFactorEnabled: user.twoFactorEnabled }).from(user).limit(1);
  if (!owner) return { kind: 'no_owner' };
  return owner.twoFactorEnabled ? { kind: 'complete', ownerId: owner.id } : { kind: 'owner_without_2fa', ownerId: owner.id };
}

export async function ownerExists(): Promise<boolean> {
  const [row] = await db.select({ total: count() }).from(user);
  return (row?.total ?? 0) > 0;
}

const emailSchema = z
  .string('e-mail requis')
  .trim()
  .toLowerCase()
  .max(200, '200 caractères au maximum')
  .pipe(z.email('adresse e-mail invalide'));

export const createOwnerSchema = z
  .object({
    token: z.string('jeton requis').trim().min(1, 'jeton requis').max(500),
    name: z.string('nom requis').trim().min(1, 'nom requis').max(80, '80 caractères au maximum'),
    email: emailSchema,
    password: z.string('mot de passe requis').max(PASSWORD_MAX_LENGTH, `${PASSWORD_MAX_LENGTH} caractères au maximum`),
    passwordConfirmation: z.string('confirmation requise'),
  })
  .superRefine((value, ctx) => {
    const problems = passwordProblems(value.password, { email: value.email, name: value.name });
    if (problems.length) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: `il faut ${problems.join(', ')}` });
    }
    if (value.password !== value.passwordConfirmation) {
      ctx.addIssue({ code: 'custom', path: ['passwordConfirmation'], message: 'les deux mots de passe diffèrent' });
    }
  });

export const resumeSetupSchema = z.object({
  token: z.string('jeton requis').trim().min(1, 'jeton requis').max(500),
  email: emailSchema,
  password: z.string('mot de passe requis').min(1, 'mot de passe requis').max(256),
});

export type CreateOwnerInput = z.input<typeof createOwnerSchema>;
export type ResumeSetupInput = z.input<typeof resumeSetupSchema>;

async function assertSetupToken(token: string, requestHeaders: Headers): Promise<void> {
  const ip = getClientIp(requestHeaders);
  assertRateLimit('setup-token', ip, AUTH_RATE_LIMITS.setupToken);
  const check = checkSetupToken(token);
  if (check === 'not_configured') {
    throw new AppError('FORBIDDEN', "Le jeton de configuration n'est pas défini sur le serveur.", {
      detail: "Renseignez SETUP_TOKEN (16 caractères au moins) dans l'environnement de Nuera Dev, puis rechargez la page.",
    });
  }
  if (check === 'invalid') {
    await audit({
      action: AUDIT_ACTIONS.setupTokenRejected,
      summary: 'configuration initiale : jeton refusé',
      actorKind: 'system',
    });
    throw new AppError('FORBIDDEN', 'Jeton de configuration incorrect.');
  }
}

/** Headers for a server-side Better Auth call made on behalf of the setup flow. */
function setupHeaders(requestHeaders: Headers, extra: Record<string, string> = {}): Headers {
  const result = new Headers();
  for (const name of ['user-agent', 'x-real-ip', 'x-forwarded-for', 'origin', 'host']) {
    const value = requestHeaders.get(name);
    if (value) result.set(name, value);
  }
  for (const [name, value] of Object.entries(extra)) result.set(name, value);
  return result;
}

function cookieHeaderFrom(setCookies: string[], existing: string | null): string {
  const pairs = new Map<string, string>();
  for (const part of (existing ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) pairs.set(name, rest.join('='));
  }
  for (const line of setCookies) {
    const [pair] = line.split(';');
    const [name, ...rest] = (pair ?? '').trim().split('=');
    if (name) pairs.set(name, rest.join('='));
  }
  return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Signs the owner in with the password (allowed before 2FA thanks to a one-time in-process nonce)
 * and makes sure a pending TOTP enrolment exists. Session cookies reach the browser through the
 * `nextCookies` plugin (call this from a server action).
 */
async function signInForSetup(email: string, password: string, requestHeaders: Headers): Promise<void> {
  let setCookies: string[] = [];
  try {
    const result = await auth.api.signInEmail({
      body: { email, password, rememberMe: true },
      headers: setupHeaders(requestHeaders, { [SETUP_NONCE_HEADER]: issueSetupNonce() }),
      returnHeaders: true,
    });
    setCookies = result.headers?.getSetCookie?.() ?? [];
  } catch (error) {
    if (isAPIError(error)) {
      const code = authErrorCode(error);
      throw new AppError(code === 'INVALID_EMAIL_OR_PASSWORD' ? 'FORBIDDEN' : 'VALIDATION', authErrorMessage(error));
    }
    throw error;
  }

  const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (!owner) throw new AppError('INTERNAL', 'Compte propriétaire introuvable après la connexion.');
  const [pending] = await db.select({ id: twoFactor.id }).from(twoFactor).where(eq(twoFactor.userId, owner.id)).limit(1);
  if (pending) return;

  try {
    await auth.api.enableTwoFactor({
      body: { password },
      headers: setupHeaders(requestHeaders, { cookie: cookieHeaderFrom(setCookies, requestHeaders.get('cookie')) }),
    });
  } catch (error) {
    if (isAPIError(error)) throw new AppError('VALIDATION', authErrorMessage(error));
    throw error;
  }
}

/** Step 1: creates the single owner (token-gated), signs them in and prepares the TOTP enrolment. */
export async function createOwner(rawInput: CreateOwnerInput, requestHeaders: Headers): Promise<void> {
  const parsed = createOwnerSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Vérifiez les champs signalés.', { detail: formatZodIssues(parsed.error, 6) });
  }
  const input = parsed.data;
  await assertSetupToken(input.token, requestHeaders);
  if (await ownerExists()) throw new AppError('CONFLICT', 'Nuera Dev a déjà un propriétaire.');

  const context = await getAuthContext();
  const hash = await context.password.hash(input.password);
  const userId = context.generateId({ model: 'user' }) || crypto.randomUUID();
  const accountId = context.generateId({ model: 'account' }) || crypto.randomUUID();
  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(user).values({
        id: userId,
        name: input.name,
        email: input.email,
        emailVerified: false,
        twoFactorEnabled: false,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(account).values({
        id: accountId,
        userId,
        accountId: userId,
        providerId: 'credential',
        password: hash,
        createdAt: now,
        updatedAt: now,
      });
    });
  } catch (error) {
    // Unique index on (true): another request created the owner first.
    if ((error as { code?: string } | null)?.code === '23505' || (await ownerExists())) {
      throw new AppError('CONFLICT', 'Nuera Dev a déjà un propriétaire.');
    }
    throw error;
  }

  await audit({
    action: AUDIT_ACTIONS.setupOwnerCreated,
    summary: `compte propriétaire créé (${input.email})`,
    actorUserId: userId,
    targetType: 'user',
    targetId: userId,
  });
  await signInForSetup(input.email, input.password, requestHeaders);
}

/** Resumes an interrupted setup (owner without 2FA): token + e-mail + password. */
export async function resumeSetup(rawInput: ResumeSetupInput, requestHeaders: Headers): Promise<void> {
  const parsed = resumeSetupSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Vérifiez les champs signalés.', { detail: formatZodIssues(parsed.error) });
  }
  await assertSetupToken(parsed.data.token, requestHeaders);
  const state = await getSetupState();
  if (state.kind !== 'owner_without_2fa') throw new AppError('CONFLICT', "Il n'y a pas de configuration à reprendre.");
  await signInForSetup(parsed.data.email, parsed.data.password, requestHeaders);
}

export interface PendingEnrolment {
  otpauthUri: string;
  /** Base32 key, grouped by 4 for manual entry (« ABCD EFGH … »). */
  manualKey: string;
}

/** TOTP enrolment waiting for its first code (null when none is pending). */
export async function getPendingEnrolment(owner: { id: string; email: string }): Promise<PendingEnrolment | null> {
  const [row] = await db
    .select({ secret: twoFactor.secret, verified: twoFactor.verified })
    .from(twoFactor)
    .where(eq(twoFactor.userId, owner.id))
    .limit(1);
  if (!row || row.verified === true) return null;
  const context = await getAuthContext();
  const rawSecret = await symmetricDecrypt({ key: context.secretConfig, data: row.secret });
  return {
    otpauthUri: buildOtpAuthUri({ rawSecret, account: owner.email }),
    manualKey: groupSecret(totpSecretToBase32(rawSecret)),
  };
}

/** Restarts the enrolment (new secret) when none is pending; requires the password. */
export async function restartEnrolment(password: string, requestHeaders: Headers): Promise<void> {
  if (!password || password.length > 256) throw new AppError('VALIDATION', 'Saisissez votre mot de passe.');
  // auth.api calls are not rate-limited by Better Auth: password guesses are capped here.
  assertRateLimit('auth:enrolment-password', getClientIp(requestHeaders), AUTH_RATE_LIMITS.sensitive);
  try {
    await auth.api.enableTwoFactor({ body: { password }, headers: requestHeaders });
  } catch (error) {
    if (isAPIError(error)) {
      throw new AppError('VALIDATION', authErrorCode(error) === 'INVALID_PASSWORD' ? 'Mot de passe incorrect.' : authErrorMessage(error));
    }
    throw error;
  }
}

/** Step 2: first TOTP code → 2FA active (Better Auth rotates the session cookie). */
export async function confirmEnrolment(rawCode: string, requestHeaders: Headers): Promise<void> {
  const code = normaliseTotpCode(rawCode);
  if (code.length !== 6) throw new AppError('VALIDATION', "Saisissez les 6 chiffres affichés par l'application.");
  assertRateLimit('auth:2fa', getClientIp(requestHeaders), AUTH_RATE_LIMITS.secondFactor);
  try {
    await auth.api.verifyTOTP({ body: { code }, headers: requestHeaders });
  } catch (error) {
    if (isAPIError(error)) throw new AppError('VALIDATION', authErrorMessage(error));
    throw error;
  }
}

/** The 8 backup codes, readable during the setup only (before they are acknowledged). */
export async function getSetupBackupCodes(ownerId: string): Promise<string[]> {
  const result = (await auth.api.viewBackupCodes({ body: { userId: ownerId } })) as { backupCodes?: unknown };
  return Array.isArray(result.backupCodes) ? result.backupCodes.filter((code): code is string => typeof code === 'string') : [];
}

/** Id of the owner's current TOTP enrolment (`two_factor` row): a 2FA reset creates a new one. */
async function currentEnrolmentId(ownerId: string): Promise<string | null> {
  const [row] = await db.select({ id: twoFactor.id }).from(twoFactor).where(eq(twoFactor.userId, ownerId)).limit(1);
  return row?.id ?? null;
}

/** True when one of `actions` was recorded for the current enrolment (older facts do not count). */
async function hasSetupFact(ownerId: string, actions: string[]): Promise<boolean> {
  const enrolmentId = await currentEnrolmentId(ownerId);
  if (!enrolmentId) return false;
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorUserId, ownerId),
        inArray(auditLog.action, actions),
        sql`${auditLog.metadata}->>'twoFactorId' = ${enrolmentId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function hasAcknowledgedCodes(ownerId: string): Promise<boolean> {
  return hasSetupFact(ownerId, [SETUP_ACTIONS.codesAcknowledged, SETUP_ACTIONS.completed]);
}

export async function isSetupCompleted(ownerId: string): Promise<boolean> {
  return hasSetupFact(ownerId, [SETUP_ACTIONS.completed]);
}

export async function acknowledgeBackupCodes(ownerId: string): Promise<void> {
  if (await hasAcknowledgedCodes(ownerId)) return;
  await audit({
    action: SETUP_ACTIONS.codesAcknowledged,
    summary: 'codes de secours conservés (configuration initiale)',
    actorUserId: ownerId,
    metadata: { twoFactorId: await currentEnrolmentId(ownerId) },
  });
}

export async function completeSetup(ownerId: string): Promise<void> {
  if (await isSetupCompleted(ownerId)) return;
  await audit({
    action: SETUP_ACTIONS.completed,
    summary: 'configuration initiale terminée',
    actorUserId: ownerId,
    metadata: { twoFactorId: await currentEnrolmentId(ownerId) },
  });
}
