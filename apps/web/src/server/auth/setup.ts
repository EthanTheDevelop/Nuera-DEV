import 'server-only';
import { auditLog, invitations, twoFactor, user } from '@nuera/db/schema';
import { isAPIError } from 'better-auth/api';
import { symmetricDecrypt } from 'better-auth/crypto';
import { and, count, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { insertAccount } from '@/server/auth/accounts';
import { auth, getAuthContext } from '@/server/auth/auth';
import { consumeEnrolmentGrant, ENROLMENT_GRANT_HEADER, issueEnrolmentGrant, type EnrolmentPurpose } from '@/server/auth/enrolment-grant';
import { authErrorCode, authErrorMessage } from '@/server/auth/messages';
import { passwordProblems, PASSWORD_MAX_LENGTH } from '@/server/auth/password-policy';
import { checkSetupToken } from '@/server/auth/setup-token';
import { buildOtpAuthUri, groupSecret, normaliseTotpCode, totpSecretToBase32 } from '@/server/auth/totp';
import { AppError, formatZodIssues } from '@/server/errors';
import { invalidateRunnerEndpoint } from '@/server/runner/config';
import { audit, AUDIT_ACTIONS } from '@/server/security/audit';
import { accountRateLimitKey, assertRateLimit, AUTH_RATE_LIMITS } from '@/server/security/rate-limit';
import { getClientIp } from '@/server/security/request-info';
import { invalidateSettingsCache } from '@/server/settings';
import { invalidateContextCache } from '@/server/tenancy/context';
import { twoFactorRequired } from '@/server/auth/policy';

/**
 * First owner (/configuration) and the activation steps shared by every account
 * (docs/MULTICOMPTE.md §6): SETUP_TOKEN → owner account → mandatory TOTP enrolment → backup codes
 * acknowledged → optional passkey → done. Invited and recovered accounts reach the same steps 2-4
 * (« Activation de votre compte ») through their link (server/auth/links.ts).
 *
 * /configuration only exists while no owner has an active 2FA: once the owner's 2FA is on, it is a
 * 404 for good; an owner without 2FA (interrupted setup) resumes with the token and its credentials.
 *
 * Progress facts live in `audit_log` (append-only): `auth.setup_codes_acknowledged`,
 * `auth.setup_completed`, tied to the TOTP enrolment they belong to (`metadata.twoFactorId`), so
 * that an activation resumed after a 2FA reset (recovery link) shows the new backup codes again.
 * Password sign-in without 2FA is refused everywhere except through an enrolment grant
 * (server/auth/enrolment-grant.ts, checked by auth.ts).
 */

export const SETUP_ACTIONS = {
  codesAcknowledged: 'auth.setup_codes_acknowledged',
  completed: 'auth.setup_completed',
} as const;

export type SetupState =
  | { kind: 'no_owner' }
  | { kind: 'owner_without_2fa'; ownerId: string }
  | { kind: 'complete'; ownerId: string };

/** State of the instance's owner (role `owner`: at most one, `user_owner_idx`). */
export async function getSetupState(): Promise<SetupState> {
  const [owner] = await db
    .select({ id: user.id, twoFactorEnabled: user.twoFactorEnabled })
    .from(user)
    .where(eq(user.role, 'owner'))
    .limit(1);
  if (!owner) return { kind: 'no_owner' };
  return owner.twoFactorEnabled || !twoFactorRequired() ? { kind: 'complete', ownerId: owner.id } : { kind: 'owner_without_2fa', ownerId: owner.id };
}

export async function ownerExists(): Promise<boolean> {
  const [row] = await db.select({ total: count() }).from(user).where(eq(user.role, 'owner'));
  return (row?.total ?? 0) > 0;
}

const emailSchema = z
  .string('e-mail requis')
  .trim()
  .toLowerCase()
  .max(200, '200 caractères au maximum')
  .pipe(z.email('adresse e-mail invalide'));

/** Name + password chosen twice (rules of password-policy.ts), shared by the owner and invitations. */
export const newPasswordFields = {
  password: z.string('mot de passe requis').max(PASSWORD_MAX_LENGTH, `${PASSWORD_MAX_LENGTH} caractères au maximum`),
  passwordConfirmation: z.string('confirmation requise'),
};

export function refineNewPassword(
  value: { password: string; passwordConfirmation: string; email: string; name?: string },
  ctx: z.RefinementCtx,
): void {
  const problems = passwordProblems(value.password, { email: value.email, name: value.name ?? '' });
  if (problems.length) {
    ctx.addIssue({ code: 'custom', path: ['password'], message: `il faut ${problems.join(', ')}` });
  }
  if (value.password !== value.passwordConfirmation) {
    ctx.addIssue({ code: 'custom', path: ['passwordConfirmation'], message: 'les deux mots de passe diffèrent' });
  }
}

export const createOwnerSchema = z
  .object({
    token: z.string('jeton requis').trim().min(1, 'jeton requis').max(500),
    name: z.string('nom requis').trim().min(1, 'nom requis').max(80, '80 caractères au maximum'),
    email: emailSchema,
    ...newPasswordFields,
  })
  .superRefine(refineNewPassword);

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

/** Headers for a server-side Better Auth call made on behalf of a token-gated flow. */
function forwardedHeaders(requestHeaders: Headers, extra: Record<string, string> = {}): Headers {
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
 * Signs an account without 2FA in with its password — allowed only with an enrolment grant bound to
 * `email` (issued here, after the caller checked the setup token or a single-use link) — and makes
 * sure a pending TOTP enrolment exists. Session cookies reach the browser through the `nextCookies`
 * plugin (call this from a server action). A wrong password answers FORBIDDEN « Mot de passe
 * incorrect. » / « E-mail ou mot de passe incorrect. ».
 */
export async function signInForEnrolment(
  email: string,
  password: string,
  requestHeaders: Headers,
  purpose: EnrolmentPurpose,
): Promise<{ userId: string }> {
  let setCookies: string[] = [];
  const grant = issueEnrolmentGrant({ email, purpose });
  try {
    const result = await auth.api.signInEmail({
      body: { email, password, rememberMe: true },
      headers: forwardedHeaders(requestHeaders, { [ENROLMENT_GRANT_HEADER]: grant }),
      returnHeaders: true,
    });
    setCookies = result.headers?.getSetCookie?.() ?? [];
  } catch (error) {
    if (isAPIError(error)) {
      const code = authErrorCode(error);
      if (code === 'INVALID_EMAIL_OR_PASSWORD') {
        throw new AppError('FORBIDDEN', purpose === 'setup' ? authErrorMessage(error) : 'Mot de passe incorrect.');
      }
      throw new AppError(code === 'ACCOUNT_DISABLED' ? 'FORBIDDEN' : 'VALIDATION', authErrorMessage(error));
    }
    throw error;
  } finally {
    // Never left alive after this call (a wrong password, or an account that already has its 2FA).
    consumeEnrolmentGrant(grant, null);
  }

  const [account] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (!account) throw new AppError('INTERNAL', 'Compte introuvable après la connexion.');
  const [pending] = await db.select({ id: twoFactor.id }).from(twoFactor).where(eq(twoFactor.userId, account.id)).limit(1);
  if (pending) return { userId: account.id };

  try {
    await auth.api.enableTwoFactor({
      body: { password },
      headers: forwardedHeaders(requestHeaders, { cookie: cookieHeaderFrom(setCookies, requestHeaders.get('cookie')) }),
    });
  } catch (error) {
    if (isAPIError(error)) throw new AppError('VALIDATION', authErrorMessage(error));
    throw error;
  }
  return { userId: account.id };
}

const OWNER_EXISTS = 'Nuera Dev est déjà configuré : connectez-vous.';

/**
 * Step 1: creates the owner (token-gated), under an advisory lock so that two concurrent requests can
 * never both pass the « no owner yet » check; then signs them in and prepares the TOTP enrolment.
 */
export async function createOwner(rawInput: CreateOwnerInput, requestHeaders: Headers): Promise<void> {
  const parsed = createOwnerSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Vérifiez les champs signalés.', { detail: formatZodIssues(parsed.error, 6) });
  }
  const input = parsed.data;
  await assertSetupToken(input.token, requestHeaders);
  if (await ownerExists()) throw new AppError('CONFLICT', OWNER_EXISTS);

  const context = await getAuthContext();
  const passwordHash = await context.password.hash(input.password);
  const userId = context.generateId({ model: 'user' }) || crypto.randomUUID();
  const credentialId = context.generateId({ model: 'account' }) || crypto.randomUUID();
  let created: Awaited<ReturnType<typeof insertAccount>>;
  try {
    created = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('nuera:first-owner'))`);
      const [existing] = await tx.select({ id: user.id }).from(user).where(eq(user.role, 'owner')).limit(1);
      if (existing) throw new AppError('CONFLICT', OWNER_EXISTS);
      const [sameEmail] = await tx.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${input.email}`).limit(1);
      if (sameEmail) throw new AppError('CONFLICT', 'Un compte existe déjà avec cette adresse e-mail.');
      return insertAccount(tx, {
        userId,
        credentialId,
        name: input.name,
        email: input.email,
        passwordHash,
        role: 'owner',
        owner: true,
      });
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    // user_owner_idx / e-mail unique: another request created the owner first.
    if ((error as { code?: string } | null)?.code === '23505' || (await ownerExists())) throw new AppError('CONFLICT', OWNER_EXISTS);
    throw error;
  }
  invalidateContextCache(userId);
  invalidateSettingsCache();
  if (created.environmentId) invalidateRunnerEndpoint(created.environmentId);

  await audit({
    action: AUDIT_ACTIONS.setupOwnerCreated,
    summary: `compte propriétaire créé (${input.email})`,
    actorUserId: userId,
    subjectUserId: userId,
    targetType: 'user',
    targetId: userId,
    metadata: { spaceId: created.spaceId, environmentId: created.environmentId },
  });
  await signInForEnrolment(input.email, input.password, requestHeaders, 'setup');
}

/** Resumes an interrupted setup (owner without 2FA): token + the owner's e-mail + password. */
export async function resumeSetup(rawInput: ResumeSetupInput, requestHeaders: Headers): Promise<void> {
  const parsed = resumeSetupSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Vérifiez les champs signalés.', { detail: formatZodIssues(parsed.error) });
  }
  await assertSetupToken(parsed.data.token, requestHeaders);
  const state = await getSetupState();
  if (state.kind !== 'owner_without_2fa') throw new AppError('CONFLICT', "Il n'y a pas de configuration à reprendre.");
  const [owner] = await db.select({ email: user.email }).from(user).where(eq(user.id, state.ownerId)).limit(1);
  // The token resumes the OWNER's setup only (never another account without 2FA).
  if (!owner || owner.email.toLowerCase() !== parsed.data.email) throw new AppError('FORBIDDEN', 'E-mail ou mot de passe incorrect.');
  await signInForEnrolment(parsed.data.email, parsed.data.password, requestHeaders, 'setup');
}

/** The activation of an invited or recovered account is complete: its link can no longer resume it. */
export async function markActivationCompleted(userId: string): Promise<void> {
  await db
    .update(invitations)
    .set({ completedAt: new Date() })
    .where(and(eq(invitations.userId, userId), isNotNull(invitations.acceptedAt), isNull(invitations.completedAt)));
}

export interface PendingEnrolment {
  otpauthUri: string;
  /** Base32 key, grouped by 4 for manual entry (« ABCD EFGH … »). */
  manualKey: string;
}

/** TOTP enrolment waiting for its first code (null when none is pending). */
export async function getPendingEnrolment(account: { id: string; email: string }): Promise<PendingEnrolment | null> {
  const [row] = await db
    .select({ secret: twoFactor.secret, verified: twoFactor.verified })
    .from(twoFactor)
    .where(eq(twoFactor.userId, account.id))
    .limit(1);
  if (!row || row.verified === true) return null;
  const context = await getAuthContext();
  const rawSecret = await symmetricDecrypt({ key: context.secretConfig, data: row.secret });
  return {
    otpauthUri: buildOtpAuthUri({ rawSecret, account: account.email }),
    manualKey: groupSecret(totpSecretToBase32(rawSecret)),
  };
}

/** Restarts the enrolment (new secret) when none is pending; requires the password. */
export async function restartEnrolment(password: string, requestHeaders: Headers, account?: { id: string }): Promise<void> {
  if (!password || password.length > 256) throw new AppError('VALIDATION', 'Saisissez votre mot de passe.');
  // auth.api calls are not rate-limited by Better Auth: password guesses are capped here.
  assertRateLimit('auth:enrolment-password', accountRateLimitKey(getClientIp(requestHeaders), account?.id), AUTH_RATE_LIMITS.enrolment);
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
export async function confirmEnrolment(rawCode: string, requestHeaders: Headers, account?: { id: string }): Promise<void> {
  const code = normaliseTotpCode(rawCode);
  if (code.length !== 6) throw new AppError('VALIDATION', "Saisissez les 6 chiffres affichés par l'application.");
  const ip = getClientIp(requestHeaders);
  assertRateLimit('auth:enrolment', accountRateLimitKey(ip, account?.id), AUTH_RATE_LIMITS.enrolment);
  assertRateLimit('auth:2fa-ip', ip, AUTH_RATE_LIMITS.secondFactorPerIp);
  try {
    await auth.api.verifyTOTP({ body: { code }, headers: requestHeaders });
  } catch (error) {
    if (isAPIError(error)) throw new AppError('VALIDATION', authErrorMessage(error));
    throw error;
  }
  if (account) await markActivationCompleted(account.id);
}

/** The 8 backup codes, readable during the activation only (before they are acknowledged). */
export async function getSetupBackupCodes(userId: string): Promise<string[]> {
  const result = (await auth.api.viewBackupCodes({ body: { userId } })) as { backupCodes?: unknown };
  return Array.isArray(result.backupCodes) ? result.backupCodes.filter((code): code is string => typeof code === 'string') : [];
}

/** Id of the account's current TOTP enrolment (`two_factor` row): a 2FA reset creates a new one. */
async function currentEnrolmentId(userId: string): Promise<string | null> {
  const [row] = await db.select({ id: twoFactor.id }).from(twoFactor).where(eq(twoFactor.userId, userId)).limit(1);
  return row?.id ?? null;
}

/** True when one of `actions` was recorded for the current enrolment (older facts do not count). */
async function hasSetupFact(userId: string, actions: string[]): Promise<boolean> {
  const enrolmentId = await currentEnrolmentId(userId);
  if (!enrolmentId) return false;
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorUserId, userId),
        inArray(auditLog.action, actions),
        sql`${auditLog.metadata}->>'twoFactorId' = ${enrolmentId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function hasAcknowledgedCodes(userId: string): Promise<boolean> {
  return hasSetupFact(userId, [SETUP_ACTIONS.codesAcknowledged, SETUP_ACTIONS.completed]);
}

export async function isSetupCompleted(userId: string): Promise<boolean> {
  return hasSetupFact(userId, [SETUP_ACTIONS.completed]);
}

async function isOwner(userId: string): Promise<boolean> {
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1);
  return row?.role === 'owner';
}

export async function acknowledgeBackupCodes(userId: string): Promise<void> {
  if (await hasAcknowledgedCodes(userId)) return;
  await audit({
    action: SETUP_ACTIONS.codesAcknowledged,
    summary: (await isOwner(userId)) ? 'codes de secours conservés (configuration initiale)' : 'codes de secours conservés (activation du compte)',
    actorUserId: userId,
    metadata: { twoFactorId: await currentEnrolmentId(userId) },
  });
}

export async function completeSetup(userId: string): Promise<void> {
  await markActivationCompleted(userId);
  if (await isSetupCompleted(userId)) return;
  await audit({
    action: SETUP_ACTIONS.completed,
    summary: (await isOwner(userId)) ? 'configuration initiale terminée' : 'activation du compte terminée',
    actorUserId: userId,
    metadata: { twoFactorId: await currentEnrolmentId(userId) },
  });
}
