import { runMigrations } from '@nuera/db/migrate';
import { account, auditLog, session, user, verification } from '@nuera/db/schema';
import { hashToken } from '@nuera/shared/tokens';
import { and, desc, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * « Mot de passe oublié » avec le vrai Better Auth (hachage) et une vraie base PostgreSQL :
 * aucune différence de réponse selon l'existence du compte, e-mail seulement vers un compte actif,
 * jeton stocké haché, usage unique, expiration, remplacement par une nouvelle demande, accès fermés.
 * Base `nuera_x3_password_reset`, recréée à chaque exécution.
 */

const env = vi.hoisted(() => {
  const admin = process.env.NUERA_TEST_PG_ADMIN_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/postgres';
  const database = new URL(admin);
  database.pathname = '/nuera_x3_password_reset';
  const values = { ADMIN_URL: admin, DATABASE_URL: database.toString(), APP_URL: 'http://localhost:3997', SETUP_TOKEN: 'tests-only-setup-token-0123456789' };
  process.env.DATABASE_URL = values.DATABASE_URL;
  process.env.APP_URL = values.APP_URL;
  process.env.SETUP_TOKEN = values.SETUP_TOKEN;
  process.env.BETTER_AUTH_SECRET = 'tests-only-better-auth-secret-0123456789abcdef';
  process.env.NUERA_RATE_LIMIT_FACTOR = '50';
  process.env.SMTP_URL = 'json';
  process.env.MAIL_FROM = 'Nuera Dev <hello@nuera.studio>';
  delete process.env.BETTER_AUTH_URL;
  delete process.env.TRUSTED_IP_HEADER;
  return values;
});

const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; text: string; html: string }> }));

vi.mock('@/server/mail', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/mail')>();
  return { ...original, sendMail: async (message: (typeof mail.sent)[number]) => void mail.sent.push(message) };
});

const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock('next/headers', async () => {
  const { cookieStore } = await import('./test/helpers');
  return { headers: async () => request.headers, cookies: async () => cookieStore(request.headers) };
});

const helpers = await import('./test/helpers');
const available = await helpers.postgresAvailable(env.ADMIN_URL, 'password-reset.test');
const headersFor = () => helpers.requestFrom(env.APP_URL);

const { createOwner } = await import('./setup');
const { getAuthContext } = await import('./auth');
const reset = await import('./password-reset');
const { db } = await import('@/server/db');

const OWNER = { name: 'Ethan Martin', email: 'ethan@test.nuera.local', password: 'Riviere-Bleue-2026!' };
const NEW_PASSWORD = 'Ardoise-Claire-2026!';
let ownerId = '';

function tokenFromMail(): string {
  const last = mail.sent.at(-1)!;
  const match = /\/mot-de-passe-oublie\/([A-Za-z0-9_-]{43})/.exec(last.text);
  return match![1]!;
}

async function passwordMatches(password: string): Promise<boolean> {
  const [row] = await db.select({ hash: account.password }).from(account).where(and(eq(account.userId, ownerId), eq(account.providerId, 'credential')));
  const context = await getAuthContext();
  return context.password.verify({ hash: row!.hash!, password });
}

async function resetRows() {
  return db.select().from(verification).where(like(verification.identifier, 'password-reset:%'));
}

describe.skipIf(!available)('mot de passe oublié (Better Auth + PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    await helpers.recreateDatabase(env.ADMIN_URL, 'nuera_x3_password_reset');
    await runMigrations(env.DATABASE_URL);
    request.headers = headersFor();
    await createOwner({ token: env.SETUP_TOKEN, ...OWNER, passwordConfirmation: OWNER.password }, request.headers);
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, OWNER.email));
    ownerId = row!.id;
  }, 180_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }).catch(() => undefined);
    await helpers.recreateDatabase(env.ADMIN_URL, 'nuera_x3_password_reset', true);
  }, 60_000);

  beforeEach(() => {
    mail.sent.length = 0;
  });

  it("adresse inconnue : même réponse, aucun e-mail, aucun lien", async () => {
    await expect(reset.requestPasswordReset('personne@test.nuera.local', headersFor())).resolves.toBeUndefined();
    expect(mail.sent).toHaveLength(0);
    expect(await resetRows()).toHaveLength(0);
  });

  it('adresse mal formée : refusée', async () => {
    await expect(reset.requestPasswordReset('pas-un-email', headersFor())).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('compte actif : e-mail avec un lien, jeton stocké haché, une nouvelle demande remplace la précédente', async () => {
    await reset.requestPasswordReset(OWNER.email.toUpperCase(), headersFor());
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: OWNER.email, subject: 'Réinitialiser votre mot de passe Nuera Dev' });
    const first = tokenFromMail();
    expect(mail.sent[0]!.text).toContain(`${env.APP_URL}/mot-de-passe-oublie/${first}`);
    const rows = await resetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ identifier: `password-reset:${hashToken(first)}`, value: ownerId });
    expect(JSON.stringify(rows)).not.toContain(first);
    const [logged] = await db.select().from(auditLog).where(eq(auditLog.action, 'auth.password_reset_requested')).orderBy(desc(auditLog.id)).limit(1);
    expect(logged).toMatchObject({ actorUserId: ownerId });

    await reset.requestPasswordReset(OWNER.email, headersFor());
    const second = tokenFromMail();
    expect(await reset.getPasswordResetState(first)).toEqual({ kind: 'invalid' });
    expect(await reset.getPasswordResetState(second)).toEqual({ kind: 'valid', email: OWNER.email });
    expect(await resetRows()).toHaveLength(1);
  });

  it('lien : nouveau mot de passe, accès web fermés, usage unique', async () => {
    await reset.requestPasswordReset(OWNER.email, headersFor());
    const token = tokenFromMail();
    await db.insert(session).values({ id: 'sess-reset', token: 'sess-reset-token', userId: ownerId, expiresAt: new Date(Date.now() + 3_600_000) });

    await expect(reset.resetPasswordWithToken(token, { password: 'court', passwordConfirmation: 'court' }, headersFor())).rejects.toMatchObject({ code: 'VALIDATION' });
    await reset.resetPasswordWithToken(token, { password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD }, headersFor());

    expect(await passwordMatches(NEW_PASSWORD)).toBe(true);
    expect(await passwordMatches(OWNER.password)).toBe(false);
    expect(await db.select().from(session).where(eq(session.userId, ownerId))).toHaveLength(0);
    expect(await reset.getPasswordResetState(token)).toEqual({ kind: 'invalid' });
    await expect(reset.resetPasswordWithToken(token, { password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD }, headersFor())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [logged] = await db.select().from(auditLog).where(eq(auditLog.action, 'auth.password_reset')).orderBy(desc(auditLog.id)).limit(1);
    expect(logged).toMatchObject({ actorUserId: ownerId, subjectUserId: ownerId });
  });

  it('lien expiré : refusé', async () => {
    await reset.requestPasswordReset(OWNER.email, headersFor());
    const token = tokenFromMail();
    await db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(verification.identifier, `password-reset:${hashToken(token)}`));
    expect(await reset.getPasswordResetState(token)).toEqual({ kind: 'expired' });
    await expect(reset.resetPasswordWithToken(token, { password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD }, headersFor())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('compte désactivé : aucun e-mail, et un lien déjà envoyé ne sert plus', async () => {
    await reset.requestPasswordReset(OWNER.email, headersFor());
    const token = tokenFromMail();
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, ownerId));
    mail.sent.length = 0;
    await reset.requestPasswordReset(OWNER.email, headersFor());
    expect(mail.sent).toHaveLength(0);
    expect(await reset.getPasswordResetState(token)).toEqual({ kind: 'invalid' });
    await db.update(user).set({ disabledAt: null }).where(eq(user.id, ownerId));
  });
});
