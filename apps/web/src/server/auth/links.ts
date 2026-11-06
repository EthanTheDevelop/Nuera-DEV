import 'server-only';
import { account, environments, invitations, session, user, verification } from '@nuera/db/schema';
import type { InstanceRole } from '@nuera/db/schema';
import { hashToken, isLinkToken } from '@nuera/shared/tokens';
import { and, eq, gt, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { emailTaken, insertAccount } from '@/server/auth/accounts';
import { getAuthContext } from '@/server/auth/auth';
import type { CurrentUser } from '@/server/auth/session';
import { newPasswordFields, refineNewPassword, signInForEnrolment } from '@/server/auth/setup';
import { AppError, formatZodIssues } from '@/server/errors';
import { invalidateRunnerEndpoint } from '@/server/runner/config';
import { audit } from '@/server/security/audit';
import { assertRateLimit, AUTH_RATE_LIMITS } from '@/server/security/rate-limit';
import { getClientIp } from '@/server/security/request-info';
import { invalidateSettingsCache } from '@/server/settings';
import { invalidateContextCache } from '@/server/tenancy/context';

/**
 * Public side of the single-use links (docs/MULTICOMPTE.md §6), pages /invitation/<jeton> and
 * /recuperation/<jeton>:
 *
 * - Invitation: the person chooses a name and a password (the e-mail is the invited one). ONE
 *   transaction consumes the link (conditional UPDATE: not accepted, not revoked, not expired) and
 *   creates account + personal space + membership + settings + preferences + the pre-assigned
 *   `pending` server (→ `active`); then an enrolment grant signs the account in for « Activation de
 *   votre compte » (TOTP → codes de secours → clé d'accès). Until the second factor is enrolled
 *   (`completed_at`), the same link resumes the activation, with the password chosen.
 * - Recovery (created by an administrator or the break-glass CLI, packages/db/src/recovery.ts): new
 *   password, then the same activation steps; the link is consumed by the same conditional UPDATE.
 *
 * Only sha256(token) is stored. A link is refused while another account is signed in on the browser.
 */

export const LINK_COPY = {
  otherAccountSignedIn: 'Vous êtes connecté avec un autre compte : déconnectez-vous pour accepter cette invitation.',
  otherAccountSignedInRecovery: 'Vous êtes connecté avec un autre compte : déconnectez-vous pour utiliser ce lien de récupération.',
} as const;

type LinkKind = 'invite' | 'recovery';

interface LinkRow {
  id: string;
  kind: LinkKind;
  email: string;
  role: InstanceRole;
  userId: string | null;
  environmentId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  completedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  createdByUserId: string | null;
}

export type LinkState =
  /** Malformed or unknown token. */
  | { kind: 'invalid' }
  | { kind: 'revoked' }
  | { kind: 'expired'; validityHours: number }
  /** Activation completed (or the account changed since): the link has served. */
  | { kind: 'used'; email: string }
  /** Another account is signed in on this browser. */
  | { kind: 'signed_in_other'; currentEmail: string }
  /** Not accepted yet: the form (password chosen twice). */
  | { kind: 'valid'; email: string; role: InstanceRole; inviterName: string | null; serverName: string | null; expiresAt: Date }
  /** Accepted, activation not finished: the password chosen resumes it. */
  | { kind: 'resume'; email: string }
  /** The account of this link is the one signed in, without its second factor: straight to the activation. */
  | { kind: 'continue' };

async function findLink(kind: LinkKind, token: string): Promise<LinkRow | null> {
  if (!isLinkToken(token)) return null;
  const [row] = await db
    .select({
      id: invitations.id,
      kind: invitations.kind,
      email: invitations.email,
      role: invitations.role,
      userId: invitations.userId,
      environmentId: invitations.environmentId,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      completedAt: invitations.completedAt,
      revokedAt: invitations.revokedAt,
      createdAt: invitations.createdAt,
      createdByUserId: invitations.createdByUserId,
    })
    .from(invitations)
    .where(and(eq(invitations.tokenHash, hashToken(token)), eq(invitations.kind, kind)))
    .limit(1);
  return (row as LinkRow | undefined) ?? null;
}

async function accountOf(userId: string | null) {
  if (!userId) return null;
  const [row] = await db
    .select({ id: user.id, email: user.email, twoFactorEnabled: user.twoFactorEnabled, disabledAt: user.disabledAt, deletedAt: user.deletedAt })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row ?? null;
}

function validityHours(row: LinkRow): number {
  return Math.max(1, Math.round((row.expiresAt.getTime() - row.createdAt.getTime()) / 3_600_000));
}

/** State of a link for the page, as seen by `current` (the account signed in on this browser, if any). */
export async function getLinkState(kind: LinkKind, token: string, current: Pick<CurrentUser, 'id' | 'email' | 'twoFactorEnabled'> | null): Promise<LinkState> {
  const row = await findLink(kind, token);
  if (!row) return { kind: 'invalid' };
  if (row.revokedAt) return { kind: 'revoked' };
  if (row.completedAt) return { kind: 'used', email: row.email };

  let state: LinkState;
  if (row.acceptedAt) {
    const owner = await accountOf(row.userId);
    if (!owner || owner.deletedAt || owner.disabledAt || owner.twoFactorEnabled) return { kind: 'used', email: row.email };
    state = { kind: 'resume', email: owner.email };
  } else if (kind === 'recovery') {
    // A recovery link is not accepted yet: its account still has to exist and be usable.
    const owner = await accountOf(row.userId);
    if (!owner || owner.deletedAt || owner.disabledAt) return { kind: 'invalid' };
    // The link reset the second factor; enrolled again since (passkey sign-in): it has nothing left to do.
    if (owner.twoFactorEnabled) return { kind: 'used', email: owner.email };
    if (row.expiresAt.getTime() <= Date.now()) return { kind: 'expired', validityHours: validityHours(row) };
    state = { kind: 'valid', email: owner.email, role: row.role, inviterName: null, serverName: null, expiresAt: row.expiresAt };
  } else {
    if (row.expiresAt.getTime() <= Date.now()) return { kind: 'expired', validityHours: validityHours(row) };
    const [inviter] = row.createdByUserId
      ? await db.select({ name: user.name }).from(user).where(and(eq(user.id, row.createdByUserId), isNull(user.deletedAt))).limit(1)
      : [];
    const [server] = row.environmentId
      ? await db
          .select({ name: environments.name })
          .from(environments)
          // A free server, or one in service the account will share (lot P1: its own Claude connection).
          .where(
            and(
              eq(environments.id, row.environmentId),
              or(and(eq(environments.status, 'pending'), isNull(environments.spaceId)), and(eq(environments.status, 'active'), isNotNull(environments.spaceId))),
            ),
          )
          .limit(1)
      : [];
    state = { kind: 'valid', email: row.email, role: row.role, inviterName: inviter?.name ?? null, serverName: server?.name ?? null, expiresAt: row.expiresAt };
  }

  if (current) {
    const sameAccount = row.userId !== null && current.id === row.userId;
    if (sameAccount && !current.twoFactorEnabled && state.kind === 'resume') return { kind: 'continue' };
    if (!sameAccount) return { kind: 'signed_in_other', currentEmail: current.email };
    // The very account of the link is signed in with its second factor: nothing left to do here.
    if (current.twoFactorEnabled) return { kind: 'used', email: row.email };
  }
  return state;
}

const nameSchema = z.string('nom requis').trim().min(1, 'nom requis').max(80, '80 caractères au maximum');

export const acceptInvitationSchema = z
  .object({ name: nameSchema, email: z.string(), ...newPasswordFields })
  .superRefine(refineNewPassword);

export const newRecoveryPasswordSchema = z
  .object({ email: z.string(), name: z.string().optional(), ...newPasswordFields })
  .superRefine(refineNewPassword);

export const resumeLinkSchema = z.object({ password: z.string('mot de passe requis').min(1, 'mot de passe requis').max(256) });

export type AcceptInvitationInput = { name: string; password: string; passwordConfirmation: string };

function unusable(kind: LinkKind): AppError {
  return new AppError(
    'CONFLICT',
    kind === 'invite' ? "Cette invitation n'est plus valide : demandez-en une nouvelle à un administrateur." : "Ce lien de récupération n'est plus valide : demandez-en un nouveau à un administrateur.",
  );
}

function assertNoOtherAccount(kind: LinkKind, current: Pick<CurrentUser, 'id'> | null, linkUserId: string | null): void {
  if (current && current.id !== linkUserId) {
    throw new AppError('CONFLICT', kind === 'invite' ? LINK_COPY.otherAccountSignedIn : LINK_COPY.otherAccountSignedInRecovery);
  }
}

function linkRateLimit(requestHeaders: Headers): void {
  assertRateLimit('auth:link', getClientIp(requestHeaders), AUTH_RATE_LIMITS.linkToken);
}

/**
 * Accepts an invitation: account created and link consumed in one transaction, then signed in for the
 * activation (the caller redirects to /configuration/double-facteur). A second submit of the same form
 * (double click) resumes the account created by the first one, with the same password.
 */
export async function acceptInvitation(
  token: string,
  rawInput: AcceptInvitationInput,
  requestHeaders: Headers,
  current: Pick<CurrentUser, 'id'> | null,
): Promise<{ userId: string; resumed: boolean }> {
  linkRateLimit(requestHeaders);
  const row = await findLink('invite', token);
  if (!row) throw unusable('invite');
  assertNoOtherAccount('invite', current, row.userId);
  const parsed = acceptInvitationSchema.safeParse({ ...rawInput, email: row.email });
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Vérifiez les champs signalés.', { detail: formatZodIssues(parsed.error, 6) });
  }
  if (row.acceptedAt) return { ...(await resumeInvitation(token, { password: parsed.data.password }, requestHeaders, current, { rateLimited: true })), resumed: true };

  const context = await getAuthContext();
  const passwordHash = await context.password.hash(parsed.data.password);
  const userId = context.generateId({ model: 'user' }) || crypto.randomUUID();
  const credentialId = context.generateId({ model: 'account' }) || crypto.randomUUID();
  const outcome = await db.transaction(async (tx) => {
    const [consumed] = await tx
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(invitations.id, row.id),
          eq(invitations.kind, 'invite'),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: invitations.id, role: invitations.role, environmentId: invitations.environmentId, createdByUserId: invitations.createdByUserId });
    if (!consumed) return null;
    if (await emailTaken(tx, row.email)) throw new AppError('CONFLICT', 'Un compte existe déjà avec cette adresse e-mail : connectez-vous.');
    const created = await insertAccount(tx, {
      userId,
      credentialId,
      name: parsed.data.name,
      email: row.email,
      passwordHash,
      role: consumed.role === 'admin' ? 'admin' : 'member',
      environmentId: consumed.environmentId,
    });
    await tx.update(invitations).set({ userId }).where(eq(invitations.id, consumed.id));
    return { created, consumed };
  });
  if (!outcome) {
    // Consumed meanwhile: by the first submit of this same form (resume), or no longer valid.
    const again = await findLink('invite', token);
    if (again?.acceptedAt && !again.completedAt && !again.revokedAt) {
      return { ...(await resumeInvitation(token, { password: parsed.data.password }, requestHeaders, current, { rateLimited: true })), resumed: true };
    }
    throw unusable('invite');
  }
  invalidateContextCache(userId);
  invalidateSettingsCache({ kind: 'user', id: userId });
  invalidateSettingsCache({ kind: 'space', id: outcome.created.spaceId });
  if (outcome.created.environmentId) {
    invalidateRunnerEndpoint(outcome.created.environmentId);
    invalidateSettingsCache({ kind: 'environment', id: outcome.created.environmentId });
  }
  await audit({
    action: 'auth.invitation_accepted',
    summary: `invitation acceptée : compte créé (${row.email})`,
    actorUserId: userId,
    subjectUserId: userId,
    targetType: 'user',
    targetId: userId,
    metadata: {
      invitationId: row.id,
      role: outcome.consumed.role,
      invitedBy: outcome.consumed.createdByUserId,
      environmentId: outcome.created.environmentId,
    },
  });
  await signInForEnrolment(row.email, parsed.data.password, requestHeaders, 'invitation');
  return { userId, resumed: false };
}

/** Resumes the activation of an accepted invitation (not completed yet) with the password chosen. */
export async function resumeInvitation(
  token: string,
  rawInput: { password: string },
  requestHeaders: Headers,
  current: Pick<CurrentUser, 'id'> | null,
  options: { rateLimited?: boolean } = {},
): Promise<{ userId: string }> {
  if (!options.rateLimited) linkRateLimit(requestHeaders);
  const parsed = resumeLinkSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError('VALIDATION', 'Saisissez le mot de passe choisi.');
  const row = await findLink('invite', token);
  if (!row || !row.acceptedAt || row.completedAt || row.revokedAt) throw unusable('invite');
  assertNoOtherAccount('invite', current, row.userId);
  const owner = await accountOf(row.userId);
  if (!owner || owner.deletedAt || owner.disabledAt || owner.twoFactorEnabled) throw unusable('invite');
  return signInForEnrolment(owner.email, parsed.data.password, requestHeaders, 'invitation');
}

/**
 * Uses a recovery link: new password (hashed by Better Auth), every access and trusted device of the
 * account closed again, link consumed — then signed in for the activation (new TOTP, new codes).
 * An accepted, not completed link resumes with the new password (`resumeRecovery`).
 */
export async function redeemRecoveryLink(
  token: string,
  rawInput: { password: string; passwordConfirmation: string },
  requestHeaders: Headers,
  current: Pick<CurrentUser, 'id'> | null,
): Promise<{ userId: string }> {
  linkRateLimit(requestHeaders);
  const row = await findLink('recovery', token);
  if (!row || !row.userId) throw unusable('recovery');
  assertNoOtherAccount('recovery', current, row.userId);
  const owner = await accountOf(row.userId);
  // Enrolled again since the link was created: it never changes the password of a recovered account.
  if (!owner || owner.deletedAt || owner.disabledAt || owner.twoFactorEnabled) throw unusable('recovery');
  const [named] = await db.select({ name: user.name }).from(user).where(eq(user.id, owner.id)).limit(1);
  const parsed = newRecoveryPasswordSchema.safeParse({ ...rawInput, email: owner.email, name: named?.name ?? '' });
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Vérifiez les champs signalés.', { detail: formatZodIssues(parsed.error, 6) });
  }
  if (row.acceptedAt) return resumeRecovery(token, { password: parsed.data.password }, requestHeaders, current, { rateLimited: true });

  const context = await getAuthContext();
  const passwordHash = await context.password.hash(parsed.data.password);
  const consumed = await db.transaction(async (tx) => {
    const [link] = await tx
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(invitations.id, row.id),
          eq(invitations.kind, 'recovery'),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: invitations.id });
    if (!link) return false;
    const now = new Date();
    const [updated] = await tx
      .update(account)
      .set({ password: passwordHash, updatedAt: now })
      .where(and(eq(account.userId, owner.id), eq(account.providerId, 'credential')))
      .returning({ id: account.id });
    if (!updated) {
      const credentialId = context.generateId({ model: 'account' }) || crypto.randomUUID();
      await tx.insert(account).values({ id: credentialId, userId: owner.id, accountId: owner.id, providerId: 'credential', password: passwordHash, createdAt: now, updatedAt: now });
    }
    await tx.delete(session).where(eq(session.userId, owner.id));
    await tx.delete(verification).where(and(like(verification.identifier, 'trust-device-%'), eq(verification.value, owner.id)));
    return true;
  });
  if (!consumed) {
    const again = await findLink('recovery', token);
    if (again?.acceptedAt && !again.completedAt && !again.revokedAt) {
      return resumeRecovery(token, { password: parsed.data.password }, requestHeaders, current, { rateLimited: true });
    }
    throw unusable('recovery');
  }
  invalidateContextCache(owner.id);
  await audit({
    action: 'auth.recovery_link_used',
    summary: 'lien de récupération utilisé : nouveau mot de passe choisi',
    actorUserId: owner.id,
    subjectUserId: owner.id,
    targetType: 'user',
    targetId: owner.id,
    metadata: { invitationId: row.id },
  });
  return signInForEnrolment(owner.email, parsed.data.password, requestHeaders, 'recovery');
}

/** Resumes the activation after a recovery link was used, with the new password. */
export async function resumeRecovery(
  token: string,
  rawInput: { password: string },
  requestHeaders: Headers,
  current: Pick<CurrentUser, 'id'> | null,
  options: { rateLimited?: boolean } = {},
): Promise<{ userId: string }> {
  if (!options.rateLimited) linkRateLimit(requestHeaders);
  const parsed = resumeLinkSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError('VALIDATION', 'Saisissez le mot de passe choisi.');
  const row = await findLink('recovery', token);
  if (!row || !row.acceptedAt || row.completedAt || row.revokedAt || !row.userId) throw unusable('recovery');
  assertNoOtherAccount('recovery', current, row.userId);
  const owner = await accountOf(row.userId);
  if (!owner || owner.deletedAt || owner.disabledAt || owner.twoFactorEnabled) throw unusable('recovery');
  return signInForEnrolment(owner.email, parsed.data.password, requestHeaders, 'recovery');
}
