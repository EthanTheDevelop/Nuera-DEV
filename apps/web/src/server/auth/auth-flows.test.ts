import { runMigrations } from '@nuera/db/migrate';
import { auditLog, session, twoFactor, user } from '@nuera/db/schema';
import { desc, eq } from 'drizzle-orm';
import { generate } from 'otplib';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listWebSessions, revokeOtherSessions, revokeWebSession } from '@/server/auth/account';
import { auth } from '@/server/auth/auth';
import { authErrorCode } from '@/server/auth/messages';
import { getCurrentUser, requireUserForApi } from '@/server/auth/session';
import {
  acknowledgeBackupCodes,
  completeSetup,
  confirmEnrolment,
  createOwner,
  getPendingEnrolment,
  getSetupBackupCodes,
  getSetupState,
  hasAcknowledgedCodes,
  isSetupCompleted,
  resumeSetup,
} from '@/server/auth/setup';
import { issueSetupNonce, SETUP_NONCE_HEADER } from '@/server/auth/setup-nonce';
import { db } from '@/server/db';

/**
 * Server-level authentication flows with the real Better Auth instance and a real PostgreSQL
 * database (no browser): token-gated owner setup, mandatory TOTP, setup steps tied to the current
 * enrolment (2FA reset + resumed setup, docs/SECURITY.md §8), idle and absolute expiry enforced on
 * every session read, 2FA removal refused, open accesses, sign-out.
 *
 * Database `nuera_auth_unit` on the local cluster (`pnpm db:local`), re-created for each run and
 * dropped afterwards; the suite is skipped with a warning when PostgreSQL does not answer.
 * `next/headers` is replaced by a per-step request (cookies written by Better Auth are read from
 * the returned `Set-Cookie` headers).
 */

const env = vi.hoisted(() => {
  const admin = process.env.NUERA_TEST_PG_ADMIN_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/postgres';
  const database = new URL(admin);
  database.pathname = '/nuera_auth_unit';
  const values = {
    ADMIN_URL: admin,
    DATABASE_URL: database.toString(),
    APP_URL: 'http://localhost:3999',
    SETUP_TOKEN: 'tests-only-setup-token-0123456789',
  };
  process.env.DATABASE_URL = values.DATABASE_URL;
  process.env.APP_URL = values.APP_URL;
  process.env.SETUP_TOKEN = values.SETUP_TOKEN;
  process.env.BETTER_AUTH_SECRET = 'tests-only-better-auth-secret-0123456789abcdef';
  process.env.NUERA_RATE_LIMIT_FACTOR = '50';
  delete process.env.BETTER_AUTH_URL;
  delete process.env.TRUSTED_IP_HEADER;
  delete process.env.TRUSTED_CITY_HEADER;
  return values;
});

/** The request seen by next/headers (headers() / cookies()) in the code under test. */
const request = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: async () => request.headers,
  cookies: async () => {
    const all = (request.headers.get('cookie') ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return { name: index < 0 ? part : part.slice(0, index), value: index < 0 ? '' : part.slice(index + 1) };
      });
    return {
      getAll: () => all,
      get: (name: string) => all.find((cookie) => cookie.name === name),
      has: (name: string) => all.some((cookie) => cookie.name === name),
      set: () => undefined,
      delete: () => undefined,
    };
  },
}));

const OWNER = { name: 'Propriétaire Test', email: 'proprietaire@test.nuera.local', password: 'Riviere-Bleue-2026!' };
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const HOUR = 3_600_000;

async function serverAvailable(): Promise<boolean> {
  const sql = postgres(env.ADMIN_URL, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    console.warn(`[auth-flows.test] PostgreSQL injoignable (${new URL(env.ADMIN_URL).host}) : tests ignorés. Lancez \`pnpm db:local\`.`);
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

const available = await serverAvailable();

async function recreateDatabase(drop = false): Promise<void> {
  const admin = postgres(env.ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe('drop database if exists "nuera_auth_unit" with (force)');
    if (!drop) await admin.unsafe('create database "nuera_auth_unit"');
  } finally {
    await admin.end({ timeout: 5 });
  }
}

function requestWith(cookie?: string, extra: Record<string, string> = {}): Headers {
  const headers = new Headers({ 'user-agent': SAFARI_MAC, origin: env.APP_URL, ...extra });
  if (cookie) headers.set('cookie', cookie);
  return headers;
}

/** Cookie jar update from Set-Cookie lines (an empty value or Max-Age=0 removes the cookie). */
function mergeCookies(setCookies: string[], existing = ''): string {
  const jar = new Map<string, string>();
  for (const part of existing.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) jar.set(name, rest.join('='));
  }
  for (const line of setCookies) {
    const [pair = '', ...attributes] = line.split(';');
    const [name = '', ...rest] = pair.trim().split('=');
    if (!name) continue;
    const value = rest.join('=');
    if (value === '' || attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute))) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function totp(manualKey: string): Promise<string> {
  return generate({ secret: manualKey.replace(/\s+/g, '') });
}

/** A valid-looking code that is not the current one. */
async function wrongTotp(manualKey: string): Promise<string> {
  return String((Number(await totp(manualKey)) + 500_000) % 1_000_000).padStart(6, '0');
}

/** Password sign-in allowed before 2FA (setup nonce, as the token-gated setup does). */
async function setupSignIn(): Promise<string> {
  const result = await auth.api.signInEmail({
    body: { email: OWNER.email, password: OWNER.password, rememberMe: true },
    headers: requestWith(undefined, { [SETUP_NONCE_HEADER]: issueSetupNonce() }),
    returnHeaders: true,
  });
  return mergeCookies(result.headers.getSetCookie());
}

/** Regular sign-in once 2FA is active: password step, then the TOTP code. */
async function signInWithTotp(manualKey: string): Promise<string> {
  const first = await auth.api.signInEmail({
    body: { email: OWNER.email, password: OWNER.password, rememberMe: true },
    headers: requestWith(),
    returnHeaders: true,
  });
  expect(first.response).toMatchObject({ twoFactorRedirect: true });
  const pending = mergeCookies(first.headers.getSetCookie());
  const second = await auth.api.verifyTOTP({
    body: { code: await totp(manualKey) },
    headers: requestWith(pending),
    returnHeaders: true,
  });
  return mergeCookies(second.headers.getSetCookie(), pending);
}

async function lastAudit(action: string) {
  const [row] = await db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)).limit(1);
  return row ?? null;
}

// Each test hashes passwords (scrypt) and talks to PostgreSQL: generous timeout for slow machines.
describe.skipIf(!available)('authentification (Better Auth + PostgreSQL)', { timeout: 90_000 }, () => {
  let manualKey = '';
  let ownerId = '';

  beforeAll(async () => {
    await recreateDatabase();
    await runMigrations(env.DATABASE_URL);
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }).catch(() => undefined);
    await recreateDatabase(true);
  }, 60_000);

  it('refuse un mauvais jeton de configuration sans rien créer', async () => {
    request.headers = requestWith();
    await expect(
      createOwner({ token: 'mauvais-jeton-de-configuration', ...OWNER, passwordConfirmation: OWNER.password }, request.headers),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Jeton de configuration incorrect.' });
    expect(await getSetupState()).toEqual({ kind: 'no_owner' });
    expect(await lastAudit('auth.setup_token_rejected')).not.toBeNull();
  });

  it('crée le propriétaire unique et refuse la connexion par mot de passe tant que la 2FA est inactive', async () => {
    await createOwner({ token: env.SETUP_TOKEN, ...OWNER, passwordConfirmation: OWNER.password }, request.headers);
    const state = await getSetupState();
    expect(state.kind).toBe('owner_without_2fa');
    ownerId = state.kind === 'owner_without_2fa' ? state.ownerId : '';
    expect(await lastAudit('auth.owner_created')).toMatchObject({ actorUserId: ownerId });

    await expect(
      createOwner({ token: env.SETUP_TOKEN, ...OWNER, passwordConfirmation: OWNER.password }, request.headers),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const refused = await auth.api
      .signInEmail({ body: { email: OWNER.email, password: OWNER.password }, headers: requestWith() })
      .catch((error: unknown) => error);
    expect(authErrorCode(refused)).toBe('SETUP_INCOMPLETE');
  });

  it('active la double authentification avec le code calculé depuis la clé affichée', async () => {
    const jar = await setupSignIn();
    request.headers = requestWith(jar);
    const me = await getCurrentUser();
    expect(me).toMatchObject({ id: ownerId, email: OWNER.email, twoFactorEnabled: false });
    await expect(requireUserForApi()).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const pending = await getPendingEnrolment(me!);
    expect(pending?.otpauthUri).toMatch(/^otpauth:\/\/totp\/Nuera%20Dev:/);
    expect(pending?.manualKey.replace(/\s+/g, '')).toMatch(/^[A-Z2-7]{32,}$/);
    manualKey = pending!.manualKey;

    await expect(confirmEnrolment(await wrongTotp(manualKey), request.headers)).rejects.toMatchObject({ code: 'VALIDATION' });
    await confirmEnrolment(await totp(manualKey), request.headers);

    const [owner] = await db.select({ twoFactorEnabled: user.twoFactorEnabled }).from(user);
    expect(owner?.twoFactorEnabled).toBe(true);
    expect(await lastAudit('auth.2fa_enabled')).toMatchObject({ actorUserId: ownerId });
    // Better Auth rotated the session when 2FA became active: the pre-2FA session is gone.
    expect(await getCurrentUser()).toBeNull();
    // From now on the password alone never opens a session.
    const first = await auth.api.signInEmail({
      body: { email: OWNER.email, password: OWNER.password },
      headers: requestWith(),
      returnHeaders: true,
    });
    expect(first.response).toMatchObject({ twoFactorRedirect: true });
  });

  it("rattache les codes conservés et la fin de configuration à l'enrôlement courant", async () => {
    request.headers = requestWith(await signInWithTotp(manualKey));
    const me = await requireUserForApi();
    expect(await getSetupBackupCodes(me.id)).toHaveLength(8);
    expect(await hasAcknowledgedCodes(me.id)).toBe(false);
    await acknowledgeBackupCodes(me.id);
    expect(await hasAcknowledgedCodes(me.id)).toBe(true);
    expect(await isSetupCompleted(me.id)).toBe(false);
    await completeSetup(me.id);
    expect(await isSetupCompleted(me.id)).toBe(true);

    // Lost phone, no backup code (docs/SECURITY.md §8): 2FA row deleted, flag cleared, accesses closed.
    await db.delete(twoFactor).where(eq(twoFactor.userId, me.id));
    await db.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, me.id));
    await db.delete(session).where(eq(session.userId, me.id));
    expect(await getSetupState()).toEqual({ kind: 'owner_without_2fa', ownerId: me.id });

    // « Reprendre la configuration »: token + credentials → a new key → the new codes are shown again.
    await resumeSetup({ token: env.SETUP_TOKEN, email: OWNER.email, password: OWNER.password }, requestWith());
    request.headers = requestWith(await setupSignIn());
    const pending = await getPendingEnrolment({ id: me.id, email: OWNER.email });
    expect(pending).not.toBeNull();
    expect(pending!.manualKey).not.toBe(manualKey);
    manualKey = pending!.manualKey;
    await confirmEnrolment(await totp(manualKey), request.headers);

    expect(await hasAcknowledgedCodes(me.id)).toBe(false);
    expect(await isSetupCompleted(me.id)).toBe(false);
    await acknowledgeBackupCodes(me.id);
    await completeSetup(me.id);
    expect(await hasAcknowledgedCodes(me.id)).toBe(true);
    expect(await isSetupCompleted(me.id)).toBe(true);
  });

  it("ferme un accès après 12 h d'inactivité et rafraîchit l'activité au plus toutes les 5 min", async () => {
    request.headers = requestWith(await signInWithTotp(manualKey));
    const me = await getCurrentUser();
    expect(me).not.toBeNull();
    const id = me!.authSessionId;

    // 6 min without activity: still valid, last activity refreshed.
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000);
    await db.update(session).set({ createdAt: sixMinutesAgo, updatedAt: sixMinutesAgo }).where(eq(session.id, id));
    expect(await getCurrentUser()).not.toBeNull();
    const [touched] = await db.select({ updatedAt: session.updatedAt }).from(session).where(eq(session.id, id));
    expect(touched!.updatedAt.getTime()).toBeGreaterThan(sixMinutesAgo.getTime() + 60_000);

    // 13 h without activity: refused, row deleted, event in the security journal.
    const thirteenHoursAgo = new Date(Date.now() - 13 * HOUR);
    await db.update(session).set({ createdAt: thirteenHoursAgo, updatedAt: thirteenHoursAgo }).where(eq(session.id, id));
    expect(await getCurrentUser()).toBeNull();
    await expect(requireUserForApi()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await db.select().from(session).where(eq(session.id, id))).toHaveLength(0);
    expect(await lastAudit('auth.session_expired')).toMatchObject({
      targetId: id,
      summary: "accès expiré après 12 h d'inactivité (Mac · Safari)",
    });
  });

  it('ferme un accès 30 jours après son ouverture, même utilisé', async () => {
    request.headers = requestWith(await signInWithTotp(manualKey));
    const id = (await getCurrentUser())!.authSessionId;
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - 30 * 24 * HOUR - 60_000), updatedAt: new Date() })
      .where(eq(session.id, id));
    expect(await getCurrentUser()).toBeNull();
    expect(await lastAudit('auth.session_expired')).toMatchObject({
      targetId: id,
      summary: 'accès expiré : durée maximale de 30 jours atteinte (Mac · Safari)',
    });
  });

  it('refuse de désactiver la double authentification', async () => {
    const jar = await signInWithTotp(manualKey);
    const refused = await auth.api
      .disableTwoFactor({ body: { password: OWNER.password }, headers: requestWith(jar) })
      .catch((error: unknown) => error);
    expect(authErrorCode(refused)).toBe('TWO_FACTOR_REQUIRED');
    const [owner] = await db.select({ twoFactorEnabled: user.twoFactorEnabled }).from(user);
    expect(owner?.twoFactorEnabled).toBe(true);
  });

  it('liste et ferme les accès ouverts, puis déconnecte cet appareil', async () => {
    const current = await signInWithTotp(manualKey);
    const other = await signInWithTotp(manualKey);
    request.headers = requestWith(current);

    const sessions = await listWebSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions[0]).toMatchObject({ current: true, deviceLabel: 'Mac · Safari', deviceKind: 'desktop' });
    expect(sessions.filter((item) => item.current)).toHaveLength(1);
    await expect(revokeWebSession(sessions[0]!.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    const { revoked } = await revokeOtherSessions();
    expect(revoked).toBeGreaterThanOrEqual(1);
    request.headers = requestWith(other);
    expect(await getCurrentUser()).toBeNull();

    await auth.api.signOut({ headers: requestWith(current) });
    request.headers = requestWith(current);
    expect(await getCurrentUser()).toBeNull();
    expect(await lastAudit('auth.other_sessions_revoked')).toMatchObject({ actorUserId: ownerId });
    expect(await lastAudit('auth.sign_out')).toMatchObject({ actorUserId: ownerId, summary: 'déconnexion (Mac · Safari)' });
  });
});
