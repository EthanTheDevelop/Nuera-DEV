import 'server-only';
import { getAuthenticatorName } from '@better-auth/passkey';
import { account, auditLog, passkey, session, spaceMembers, twoFactor, user as userTable, verification } from '@nuera/db/schema';
import { isAPIError } from 'better-auth/api';
import { and, desc, eq, inArray, like, ne, sql } from 'drizzle-orm';
import { headers } from 'next/headers';
import { z } from 'zod';
import { db } from '@/server/db';
import { auth, getAuthContext } from '@/server/auth/auth';
import { describeDevice, type DeviceKind } from '@/server/auth/device';
import { authErrorCode, authErrorMessage } from '@/server/auth/messages';
import { passwordProblems } from '@/server/auth/password-policy';
import { evaluateSessionPolicy, twoFactorRequired } from '@/server/auth/policy';
import { requireUserForApi } from '@/server/auth/session';
import { AppError, formatZodIssues } from '@/server/errors';
import { deleteSubscriptionsForSession, moveSubscriptionsToSession } from '@/server/push';
import { audit, AUDIT_ACTIONS, listUserJournal, type AuditRecord } from '@/server/security/audit';
import { assertRateLimit, AUTH_RATE_LIMITS } from '@/server/security/rate-limit';
import { displayableIp } from '@/server/security/request-info';
import { getWebSessionPolicy } from '@/server/settings';

/**
 * Account & security services for Paramètres · Compte et sécurité (D08 / M08).
 * Every function re-checks the signed-in account (AppError UNAUTHORIZED / FORBIDDEN otherwise), so
 * they can be called from server actions, Server Components and route handlers alike.
 * Mutations are audited (« Journal de sécurité »). Dates are returned as Date objects: format them
 * with @nuera/shared/format (« maintenant », « il y a 2 h », « hier 18:04 »).
 *
 *   listWebSessions()                       → Accès ouverts (current device first)
 *   revokeWebSession(id) / revokeOtherSessions()
 *   getTwoFactorSummary()                   → « Application d'authentification · 8 codes de secours restants »
 *   regenerateBackupCodes({ password })     → new codes, shown once
 *   listPasskeys() / renamePasskey(id, name) / deletePasskey(id)
 *   changePassword({ currentPassword, newPassword, revokeOtherSessions? })
 *   listSecurityJournal({ limit?, before? }) → personal journal (MULTICOMPTE §9): my events, the ones
 *                                           concerning my account, those of my space
 *
 * Adding a passkey happens in the browser: `authClient.passkey.addPasskey({ name })` from
 * src/lib/auth-client.ts (requires a session opened less than 1 h ago: error code SESSION_NOT_FRESH).
 */

// ---------------------------------------------------------------------------------------------
// Accès ouverts
// ---------------------------------------------------------------------------------------------

export interface WebSessionInfo {
  id: string;
  /** « Mac · Safari », « iPhone · Safari », « PC Windows · Chrome » (never guessed beyond the UA). */
  deviceLabel: string;
  deviceKind: DeviceKind;
  /** City from a trusted proxy header at sign-in (TRUSTED_CITY_HEADER), else null. */
  city: string | null;
  ip: string | null;
  /** What to show before the time: city, else IP, else null (« Lyon · hier 18:04 »). */
  location: string | null;
  /** « Cet appareil » */
  current: boolean;
  createdAt: Date;
  lastActiveAt: Date;
  /** When the access expires without further activity (« expire dans 6 h »). */
  expiresAt: Date;
}

export async function listWebSessions(): Promise<WebSessionInfo[]> {
  const user = await requireUserForApi();
  const policy = await getWebSessionPolicy();
  const rows = await db.select().from(session).where(eq(session.userId, user.id)).orderBy(desc(session.updatedAt));
  const now = new Date();

  const active: Array<{ row: (typeof rows)[number]; expiresAt: Date }> = [];
  const expiredIds: string[] = [];
  for (const row of rows) {
    const verdict = evaluateSessionPolicy({ createdAt: row.createdAt, lastActivityAt: row.updatedAt }, policy, now);
    if (!verdict.valid || row.expiresAt <= now) expiredIds.push(row.id);
    else active.push({ row, expiresAt: new Date(Math.min(verdict.expiresAt.getTime(), row.expiresAt.getTime())) });
  }
  if (expiredIds.length) {
    // Their push subscriptions go with them (sendPush would refuse and prune them anyway).
    for (const id of expiredIds) await deleteSubscriptionsForSession(id);
    await db.delete(session).where(and(eq(session.userId, user.id), inArray(session.id, expiredIds)));
  }

  const origins = await signInOrigins(user.id, active.map(({ row }) => row.id));
  const items = active.map(({ row, expiresAt }): WebSessionInfo => {
    const device = describeDevice(row.userAgent);
    const origin = origins.get(row.id);
    const city = origin?.city ?? null;
    const ip = origin?.ip ?? displayableIp(row.ipAddress);
    return {
      id: row.id,
      deviceLabel: device.label,
      deviceKind: device.kind,
      city,
      ip,
      location: city ?? ip,
      current: row.id === user.authSessionId,
      createdAt: row.createdAt,
      lastActiveAt: row.updatedAt,
      expiresAt,
    };
  });
  return items.sort((a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
}

/** City and IP recorded (from trusted headers) when each session was opened by a sign-in. */
async function signInOrigins(userId: string, sessionIds: string[]): Promise<Map<string, { city: string | null; ip: string | null }>> {
  const map = new Map<string, { city: string | null; ip: string | null }>();
  if (sessionIds.length === 0) return map;
  const rows = await db
    .select({
      sessionId: sql<string>`${auditLog.metadata}->>'sessionId'`,
      city: sql<string | null>`${auditLog.metadata}->>'city'`,
      ip: sql<string | null>`${auditLog.metadata}->>'ip'`,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorUserId, userId),
        inArray(auditLog.action, [AUDIT_ACTIONS.signIn, AUDIT_ACTIONS.signInNewDevice]),
        inArray(sql`${auditLog.metadata}->>'sessionId'`, sessionIds),
      ),
    );
  for (const row of rows) map.set(row.sessionId, { city: row.city ?? null, ip: displayableIp(row.ip) });
  return map;
}

const idSchema = z.string().trim().min(1).max(200);

export async function revokeWebSession(sessionId: string): Promise<void> {
  const user = await requireUserForApi();
  const id = idSchema.parse(sessionId);
  if (id === user.authSessionId) {
    throw new AppError('CONFLICT', 'Pour fermer cet appareil, utilisez « Se déconnecter ».');
  }
  const [deleted] = await db
    .delete(session)
    .where(and(eq(session.id, id), eq(session.userId, user.id)))
    .returning({ id: session.id, userAgent: session.userAgent });
  if (!deleted) throw new AppError('NOT_FOUND', "Cet accès n'existe plus.");
  // The device of a closed access no longer receives this account's notifications.
  await deleteSubscriptionsForSession(deleted.id);
  await audit({
    action: AUDIT_ACTIONS.sessionRevoked,
    summary: `accès révoqué : ${describeDevice(deleted.userAgent).label}`,
    actorUserId: user.id,
    targetType: 'session',
    targetId: deleted.id,
  });
}

export async function revokeOtherSessions(): Promise<{ revoked: number }> {
  const user = await requireUserForApi();
  const deleted = await db
    .delete(session)
    .where(and(eq(session.userId, user.id), ne(session.id, user.authSessionId)))
    .returning({ id: session.id });
  for (const row of deleted) await deleteSubscriptionsForSession(row.id);
  if (deleted.length > 0) {
    await audit({
      action: AUDIT_ACTIONS.otherSessionsRevoked,
      summary: deleted.length === 1 ? '1 autre accès fermé' : `${deleted.length} autres accès fermés`,
      actorUserId: user.id,
      metadata: { count: deleted.length },
    });
  }
  return { revoked: deleted.length };
}

// ---------------------------------------------------------------------------------------------
// Double authentification
// ---------------------------------------------------------------------------------------------

export interface TwoFactorSummary {
  enabled: boolean;
  method: 'totp';
  /** Unused backup codes, null when they cannot be read. */
  backupCodesRemaining: number | null;
  /** 2FA imposée par le serveur (NUERA_REQUIRE_2FA) : elle ne peut alors pas être désactivée. */
  required: boolean;
}

export async function getTwoFactorSummary(): Promise<TwoFactorSummary> {
  const user = await requireUserForApi();
  let remaining: number | null = null;
  try {
    const result = (await auth.api.viewBackupCodes({ body: { userId: user.id } })) as { backupCodes?: unknown };
    remaining = Array.isArray(result.backupCodes) ? result.backupCodes.length : null;
  } catch (error) {
    if (!isAPIError(error)) throw error;
  }
  return { enabled: user.twoFactorEnabled, method: 'totp', backupCodesRemaining: remaining, required: twoFactorRequired() };
}

const passwordInputSchema = z.object({ password: z.string().min(1, 'mot de passe requis').max(256) });

/** New set of 8 backup codes (the previous ones stop working). Requires the current password. */
export async function regenerateBackupCodes(input: { password: string }): Promise<{ codes: string[] }> {
  const user = await requireUserForApi();
  const parsed = passwordInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION', 'Mot de passe requis.', { detail: formatZodIssues(parsed.error) });
  assertRateLimit('auth:sensitive', user.id, AUTH_RATE_LIMITS.sensitive);
  try {
    const result = (await auth.api.generateBackupCodes({
      body: { password: parsed.data.password },
      headers: await headers(),
    })) as { backupCodes?: string[] };
    return { codes: result.backupCodes ?? [] };
  } catch (error) {
    throw toAccountError(error);
  }
}

/**
 * Désactive la double authentification du compte connecté (seulement quand le serveur la rend
 * facultative). Mot de passe redemandé ; clé TOTP, codes de secours et appareils de confiance
 * supprimés. Elle se réactive depuis /configuration/double-facteur.
 */
export async function disableTwoFactor(input: { password: string }): Promise<{ disabled: true }> {
  const current = await requireUserForApi();
  if (twoFactorRequired()) {
    throw new AppError('FORBIDDEN', 'La double authentification est obligatoire sur ce serveur.');
  }
  const parsed = passwordInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION', 'Mot de passe requis.', { detail: formatZodIssues(parsed.error) });
  assertRateLimit('auth:sensitive', current.id, AUTH_RATE_LIMITS.sensitive);
  if (!current.twoFactorEnabled) return { disabled: true };

  const [credential] = await db
    .select({ hash: account.password })
    .from(account)
    .where(and(eq(account.userId, current.id), eq(account.providerId, 'credential')))
    .limit(1);
  const context = await getAuthContext();
  const valid = credential?.hash ? await context.password.verify({ hash: credential.hash, password: parsed.data.password }) : false;
  if (!valid) throw new AppError('FORBIDDEN', 'Mot de passe incorrect.');

  await db.transaction(async (tx) => {
    await tx.delete(twoFactor).where(eq(twoFactor.userId, current.id));
    await tx.update(userTable).set({ twoFactorEnabled: false, updatedAt: new Date() }).where(eq(userTable.id, current.id));
    await tx.delete(verification).where(and(like(verification.identifier, 'trust-device-%'), eq(verification.value, current.id)));
  });
  await audit({
    action: 'auth.2fa_disabled',
    summary: 'double authentification désactivée depuis les paramètres',
    actorUserId: current.id,
    subjectUserId: current.id,
  });
  return { disabled: true };
}

// ---------------------------------------------------------------------------------------------
// Clés d'accès
// ---------------------------------------------------------------------------------------------

export interface PasskeyInfo {
  id: string;
  name: string | null;
  /** Authenticator provider from the AAGUID (« iCloud Keychain », « Google Password Manager »), when known. */
  provider: string | null;
  createdAt: Date | null;
  /** 'multiDevice' (synced) or 'singleDevice'. */
  deviceType: string;
  backedUp: boolean;
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const user = await requireUserForApi();
  const rows = await db.select().from(passkey).where(eq(passkey.userId, user.id)).orderBy(desc(passkey.createdAt));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    provider: getAuthenticatorName(row.aaguid) ?? null,
    createdAt: row.createdAt,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
  }));
}

const passkeyNameSchema = z.string().trim().min(1, 'nom requis').max(60, '60 caractères au maximum');

export async function renamePasskey(id: string, name: string): Promise<void> {
  const user = await requireUserForApi();
  const parsedName = passkeyNameSchema.safeParse(name);
  if (!parsedName.success) throw new AppError('VALIDATION', 'Nom invalide.', { detail: formatZodIssues(parsedName.error) });
  const [updated] = await db
    .update(passkey)
    .set({ name: parsedName.data })
    .where(and(eq(passkey.id, idSchema.parse(id)), eq(passkey.userId, user.id)))
    .returning({ id: passkey.id });
  if (!updated) throw new AppError('NOT_FOUND', "Clé d'accès introuvable.");
}

export async function deletePasskey(id: string): Promise<void> {
  const user = await requireUserForApi();
  const [deleted] = await db
    .delete(passkey)
    .where(and(eq(passkey.id, idSchema.parse(id)), eq(passkey.userId, user.id)))
    .returning({ id: passkey.id, name: passkey.name });
  if (!deleted) throw new AppError('NOT_FOUND', "Clé d'accès introuvable.");
  await audit({
    action: AUDIT_ACTIONS.passkeyRemoved,
    summary: deleted.name ? `clé d'accès supprimée : ${deleted.name}` : "clé d'accès supprimée",
    actorUserId: user.id,
    targetType: 'passkey',
    targetId: deleted.id,
  });
}

// ---------------------------------------------------------------------------------------------
// Mot de passe
// ---------------------------------------------------------------------------------------------

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'mot de passe actuel requis').max(256),
  newPassword: z.string().max(256),
  revokeOtherSessions: z.boolean().optional(),
});

/** Changes the password (audited). Other accesses are closed by default. */
export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions?: boolean;
}): Promise<void> {
  const user = await requireUserForApi();
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION', 'Données invalides.', { detail: formatZodIssues(parsed.error) });
  const problems = passwordProblems(parsed.data.newPassword, { email: user.email, name: user.name });
  if (problems.length) {
    throw new AppError('VALIDATION', 'Nouveau mot de passe refusé.', { detail: `Il faut ${problems.join(', ')}.` });
  }
  assertRateLimit('auth:sensitive', user.id, AUTH_RATE_LIMITS.sensitive);
  const revokeOthers = parsed.data.revokeOtherSessions ?? true;
  // Better Auth closes EVERY access of the account (this one included) and opens a new one for this
  // device: the devices of the closed accesses stop receiving notifications, this device's follow it.
  const closing = revokeOthers
    ? await db.select({ id: session.id }).from(session).where(and(eq(session.userId, user.id), ne(session.id, user.authSessionId)))
    : [];
  let result: { token?: string | null };
  try {
    result = (await auth.api.changePassword({
      body: {
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
        revokeOtherSessions: revokeOthers,
      },
      headers: await headers(),
    })) as { token?: string | null };
  } catch (error) {
    throw toAccountError(error);
  }
  if (!revokeOthers) return;
  for (const row of closing) await deleteSubscriptionsForSession(row.id);
  if (result.token) {
    const [replacement] = await db.select({ id: session.id }).from(session).where(eq(session.token, result.token)).limit(1);
    if (replacement) await moveSubscriptionsToSession(user.authSessionId, replacement.id);
  }
}

// ---------------------------------------------------------------------------------------------
// Journal de sécurité
// ---------------------------------------------------------------------------------------------

export async function listSecurityJournal(
  options: { limit?: number; before?: number } = {},
): Promise<{ items: AuditRecord[]; nextCursor: number | null }> {
  const user = await requireUserForApi();
  const memberships = await db.select({ spaceId: spaceMembers.spaceId }).from(spaceMembers).where(eq(spaceMembers.userId, user.id));
  return listUserJournal({
    userId: user.id,
    spaceIds: memberships.map((row) => row.spaceId),
    limit: options.limit ?? 20,
    ...(options.before !== undefined ? { before: options.before } : {}),
  });
}

function toAccountError(error: unknown): unknown {
  if (!isAPIError(error)) return error;
  const code = authErrorCode(error);
  if (code === 'INVALID_PASSWORD') return new AppError('VALIDATION', 'Mot de passe actuel incorrect.');
  if (error.statusCode === 429) return new AppError('RATE_LIMITED');
  if (code === 'SESSION_NOT_FRESH') return new AppError('FORBIDDEN', authErrorMessage(error));
  return new AppError('VALIDATION', authErrorMessage(error));
}
