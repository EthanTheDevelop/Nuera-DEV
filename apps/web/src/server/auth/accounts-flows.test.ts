import { runMigrations } from '@nuera/db/migrate';
import {
  auditLog,
  environments,
  invitations,
  notifications,
  session,
  spaceMembers,
  spaceSettings,
  spaces,
  user,
  userPreferences,
} from '@nuera/db/schema';
import { hashToken } from '@nuera/shared/tokens';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AdminActor } from '@/server/admin';

/**
 * Accounts of the multi-account model (docs/MULTICOMPTE.md §6) with the real Better Auth and a real
 * PostgreSQL database: invitation (form, single-use consumption, double submit, pre-assigned server,
 * resumption with the chosen password, mandatory 2FA), unusable links, disabled account refused for
 * the password AND the passkey paths, recovery link (administrator's password, accesses and 2FA
 * closed, new password, new 2FA). Database `nuera_x3_accounts`, re-created for each run.
 */

const env = vi.hoisted(() => {
  const admin = process.env.NUERA_TEST_PG_ADMIN_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/postgres';
  const database = new URL(admin);
  database.pathname = '/nuera_x3_accounts';
  const values = { ADMIN_URL: admin, DATABASE_URL: database.toString(), APP_URL: 'http://localhost:3998', SETUP_TOKEN: 'tests-only-setup-token-0123456789' };
  process.env.DATABASE_URL = values.DATABASE_URL;
  process.env.APP_URL = values.APP_URL;
  process.env.SETUP_TOKEN = values.SETUP_TOKEN;
  process.env.BETTER_AUTH_SECRET = 'tests-only-better-auth-secret-0123456789abcdef';
  process.env.NUERA_RATE_LIMIT_FACTOR = '50';
  delete process.env.BETTER_AUTH_URL;
  delete process.env.TRUSTED_IP_HEADER;
  delete process.env.TRUSTED_CITY_HEADER;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  return values;
});

const request = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', async () => {
  const { cookieStore } = await import('./test/helpers');
  return { headers: async () => request.headers, cookies: async () => cookieStore(request.headers) };
});

const helpers = await import('./test/helpers');
const { mergeCookies, totp, recreateDatabase, postgresAvailable } = helpers;
const requestWith = (cookie?: string, extra: Record<string, string> = {}) => helpers.requestFrom(env.APP_URL, cookie, extra);
const available = await postgresAvailable(env.ADMIN_URL, 'accounts-flows.test');

const { auth, assertSessionAllowed } = await import('./auth');
const { authErrorCode } = await import('./messages');
const { getCurrentUser } = await import('./session');
const { confirmEnrolment, createOwner, getPendingEnrolment } = await import('./setup');
const { ENROLMENT_GRANT_HEADER, issueEnrolmentGrant } = await import('./enrolment-grant');
const links = await import('./links');
const admin = await import('@/server/admin');
const { db } = await import('@/server/db');

const OWNER = { name: 'Ethan Martin', email: 'ethan@test.nuera.local', password: 'Riviere-Bleue-2026!' };
const MEMBER = { name: 'Camille Laurent', email: 'camille@test.nuera.local', password: 'Granit-Rose-2026!' };
const NEW_PASSWORD = 'Ardoise-Claire-2026!';

let owner: AdminActor;
let memberId = '';

function tokenOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.split('/').pop()!);
}

async function lastAudit(action: string) {
  const [row] = await db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)).limit(1);
  return row ?? null;
}

/** Password sign-in with a grant bound to `email` (what the link pages do), cookie jar returned. */
async function grantedSignIn(email: string, password: string): Promise<string> {
  const result = await auth.api.signInEmail({
    body: { email, password, rememberMe: true },
    headers: requestWith(undefined, { [ENROLMENT_GRANT_HEADER]: issueEnrolmentGrant({ email, purpose: 'invitation' }) }),
    returnHeaders: true,
  });
  return mergeCookies(result.headers.getSetCookie());
}

/** Enrols the TOTP of a signed-in account without 2FA (step 2 of the activation). */
async function enrol(email: string, password: string): Promise<string> {
  request.headers = requestWith(await grantedSignIn(email, password));
  const me = await getCurrentUser();
  expect(me).toMatchObject({ email, twoFactorEnabled: false });
  const pending = await getPendingEnrolment(me!);
  expect(pending).not.toBeNull();
  await confirmEnrolment(await totp(pending!.manualKey), request.headers, me!);
  return pending!.manualKey;
}

async function passwordSignIn(email: string, password: string): Promise<unknown> {
  return auth.api.signInEmail({ body: { email, password }, headers: requestWith() }).catch((error: unknown) => error);
}

describe.skipIf(!available)('comptes : invitation, désactivation, récupération (Better Auth + PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    await recreateDatabase(env.ADMIN_URL, 'nuera_x3_accounts');
    await runMigrations(env.DATABASE_URL);
    request.headers = requestWith();
    await createOwner({ token: env.SETUP_TOKEN, ...OWNER, passwordConfirmation: OWNER.password }, request.headers);
    const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, OWNER.email));
    owner = { id: row!.id, name: OWNER.name, email: OWNER.email, role: 'owner' };
  }, 180_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }).catch(() => undefined);
    await recreateDatabase(env.ADMIN_URL, 'nuera_x3_accounts', true);
  }, 60_000);

  it("invitation : un seul compte même sur double envoi, son espace, le serveur pré-attribué, l'activation reprise par le lien", async () => {
    const [server] = await db
      .insert(environments)
      .values({ name: 'VPS-4', status: 'pending', configSource: 'db', url: 'http://127.0.0.1:9' })
      .returning({ id: environments.id });
    const created = await admin.createInvitation(owner, { email: MEMBER.email.toUpperCase(), role: 'member', environmentId: server!.id });
    expect(created.url.startsWith(`${env.APP_URL}/invitation/`)).toBe(true);
    const token = tokenOf(created.url);
    const [stored] = await db.select().from(invitations).where(eq(invitations.id, created.id));
    expect(stored).toMatchObject({ kind: 'invite', email: MEMBER.email, role: 'member', tokenHash: hashToken(token), acceptedAt: null });
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(await lastAudit('admin.invitation_created')).toMatchObject({ actorUserId: owner.id });

    expect(await links.getLinkState('invite', token, null)).toMatchObject({ kind: 'valid', email: MEMBER.email, serverName: 'VPS-4', inviterName: OWNER.name });
    // Signed in as another account on this browser: refused, without the form.
    const signedIn = { id: owner.id, email: OWNER.email, twoFactorEnabled: true };
    expect(await links.getLinkState('invite', token, signedIn)).toEqual({ kind: 'signed_in_other', currentEmail: OWNER.email });
    await expect(links.acceptInvitation(token, { name: MEMBER.name, password: MEMBER.password, passwordConfirmation: MEMBER.password }, requestWith(), signedIn)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Vous êtes connecté avec un autre compte : déconnectez-vous pour accepter cette invitation.',
    });
    // A weak password creates nothing.
    await expect(links.acceptInvitation(token, { name: MEMBER.name, password: 'court', passwordConfirmation: 'court' }, requestWith(), null)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await db.select().from(user).where(eq(user.email, MEMBER.email))).toHaveLength(0);

    // Double submit: one account, the second request resumes it.
    const input = { name: MEMBER.name, password: MEMBER.password, passwordConfirmation: MEMBER.password };
    const results = await Promise.all([links.acceptInvitation(token, input, requestWith(), null), links.acceptInvitation(token, input, requestWith(), null)]);
    const accounts = await db.select().from(user).where(eq(user.email, MEMBER.email));
    expect(accounts).toHaveLength(1);
    memberId = accounts[0]!.id;
    expect(results.map((item) => item.userId)).toEqual([memberId, memberId]);
    expect(results.filter((item) => item.resumed)).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ role: 'member', twoFactorEnabled: false, name: MEMBER.name });

    const [space] = await db.select().from(spaces).where(eq(spaces.ownerUserId, memberId));
    expect(space).toMatchObject({ kind: 'personal', name: 'Espace de Camille' });
    expect(await db.select().from(spaceMembers).where(eq(spaceMembers.userId, memberId))).toEqual([expect.objectContaining({ spaceId: space!.id, role: 'owner' })]);
    expect(await db.select().from(spaceSettings).where(eq(spaceSettings.spaceId, space!.id))).toHaveLength(1);
    expect(await db.select().from(userPreferences).where(eq(userPreferences.userId, memberId))).toHaveLength(1);
    const [attached] = await db.select().from(environments).where(eq(environments.id, server!.id));
    expect(attached).toMatchObject({ spaceId: space!.id, status: 'active' });
    expect(await lastAudit('auth.invitation_accepted')).toMatchObject({ actorUserId: memberId, subjectUserId: memberId });

    // Until the second factor: the link resumes with the chosen password, never with another one.
    expect(await links.getLinkState('invite', token, null)).toEqual({ kind: 'resume', email: MEMBER.email });
    expect(await links.getLinkState('invite', token, { id: memberId, email: MEMBER.email, twoFactorEnabled: false })).toEqual({ kind: 'continue' });
    await expect(links.resumeInvitation(token, { password: 'Mauvais-Mot-2026!' }, requestWith(), null)).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Mot de passe incorrect.' });
    await expect(links.resumeInvitation(token, { password: MEMBER.password }, requestWith(), null)).resolves.toEqual({ userId: memberId });
    // The password alone (no grant) never opens a session for an account without 2FA.
    expect(authErrorCode(await passwordSignIn(MEMBER.email, MEMBER.password))).toBe('ACTIVATION_INCOMPLETE');

    await enrol(MEMBER.email, MEMBER.password);
    const [completed] = await db.select({ completedAt: invitations.completedAt }).from(invitations).where(eq(invitations.id, created.id));
    expect(completed!.completedAt).not.toBeNull();
    expect(await links.getLinkState('invite', token, null)).toEqual({ kind: 'used', email: MEMBER.email });
    await expect(links.resumeInvitation(token, { password: MEMBER.password }, requestWith(), null)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await passwordSignIn(MEMBER.email, MEMBER.password)).toMatchObject({ twoFactorRedirect: true });
  });

  it('liens inconnus, expirés, annulés ; adresse déjà utilisée ; un membre ne peut pas inviter', async () => {
    expect(await links.getLinkState('invite', '../../etc/passwd', null)).toEqual({ kind: 'invalid' });
    expect(await links.getLinkState('invite', 'a'.repeat(43), null)).toEqual({ kind: 'invalid' });

    const expired = await admin.createInvitation(owner, { email: 'expire@test.nuera.local', validityHours: 24 });
    await db
      .update(invitations)
      .set({ createdAt: new Date(Date.now() - 24 * 3_600_000 - 60_000), expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(invitations.id, expired.id));
    expect(await links.getLinkState('invite', tokenOf(expired.url), null)).toEqual({ kind: 'expired', validityHours: 24 });
    await expect(
      links.acceptInvitation(tokenOf(expired.url), { name: 'Expiré', password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD }, requestWith(), null),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await db.select().from(user).where(eq(user.email, 'expire@test.nuera.local'))).toHaveLength(0);
    // Inviting the same address again replaces the expired link.
    const renewed = await admin.createInvitation(owner, { email: 'expire@test.nuera.local' });
    expect(await links.getLinkState('invite', tokenOf(expired.url), null)).toEqual({ kind: 'revoked' });
    expect(await links.getLinkState('invite', tokenOf(renewed.url), null)).toMatchObject({ kind: 'valid' });

    await admin.revokeInvitation(owner, renewed.id);
    expect(await links.getLinkState('invite', tokenOf(renewed.url), null)).toEqual({ kind: 'revoked' });
    await expect(admin.revokeInvitation(owner, renewed.id)).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Invitation introuvable.' });
    await expect(admin.revokeInvitation(owner, 'pas-un-id')).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Invitation introuvable.' });

    await expect(admin.createInvitation(owner, { email: MEMBER.email })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(admin.createInvitation({ id: memberId, name: MEMBER.name, email: MEMBER.email, role: 'member' }, { email: 'x@test.nuera.local' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // Public sign-up stays closed, whatever the path.
    const signUp = await auth.api
      .signUpEmail({ body: { name: 'Intrus', email: 'intrus@test.nuera.local', password: NEW_PASSWORD }, headers: requestWith() })
      .catch((error: unknown) => error);
    expect(signUp).toBeInstanceOf(Error);
    expect(await db.select().from(user).where(eq(user.email, 'intrus@test.nuera.local'))).toHaveLength(0);
  });

  it("compte désactivé : refusé par mot de passe comme par clé d'accès (après la vérification), son serveur suspendu ; réactivé", async () => {
    await expect(admin.disableAccount(owner, owner.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const disabled = await admin.disableAccount(owner, memberId, { stopSessions: false });
    expect(disabled.server).toMatchObject({ name: 'VPS-4' });
    const [suspended] = await db.select({ status: environments.status }).from(environments).where(eq(environments.id, disabled.server!.id));
    expect(suspended!.status).toBe('suspended');
    expect(await db.select().from(session).where(eq(session.userId, memberId))).toHaveLength(0);
    expect(await lastAudit('admin.account_disabled')).toMatchObject({ actorUserId: owner.id, subjectUserId: memberId });

    expect(authErrorCode(await passwordSignIn(MEMBER.email, MEMBER.password))).toBe('ACCOUNT_DISABLED');
    // A wrong password answers like for any account (the refusal never reveals the state of an e-mail).
    expect(authErrorCode(await passwordSignIn(MEMBER.email, 'Mauvais-Mot-2026!'))).toBe('INVALID_EMAIL_OR_PASSWORD');
    await expect(assertSessionAllowed(memberId, { path: '/passkey/verify-authentication' })).rejects.toMatchObject({ body: { code: 'ACCOUNT_DISABLED' } });
    expect(await lastAudit('auth.sign_in_failed')).toMatchObject({ subjectUserId: memberId });

    await admin.enableAccount(owner, memberId);
    const [active] = await db.select({ status: environments.status }).from(environments).where(eq(environments.id, disabled.server!.id));
    expect(active!.status).toBe('active');
    expect(await passwordSignIn(MEMBER.email, MEMBER.password)).toMatchObject({ twoFactorRedirect: true });
  });

  it("lien de récupération : mot de passe de l'administrateur, accès et 2FA fermés, nouveau mot de passe puis nouvelle 2FA", async () => {
    await expect(admin.createAccountRecoveryLink(owner, memberId, { password: 'Mauvais-Mot-2026!' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Votre mot de passe est incorrect.',
    });
    const [untouched] = await db.select({ twoFactorEnabled: user.twoFactorEnabled }).from(user).where(eq(user.id, memberId));
    expect(untouched!.twoFactorEnabled).toBe(true);
    await expect(admin.createAccountRecoveryLink(owner, owner.id, { password: OWNER.password })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const link = await admin.createAccountRecoveryLink(owner, memberId, { password: OWNER.password });
    expect(link.url.startsWith(`${env.APP_URL}/recuperation/`)).toBe(true);
    const [reset] = await db.select({ twoFactorEnabled: user.twoFactorEnabled }).from(user).where(eq(user.id, memberId));
    expect(reset!.twoFactorEnabled).toBe(false);
    expect(await db.select().from(session).where(eq(session.userId, memberId))).toHaveLength(0);
    expect(await lastAudit('admin.recovery_link_created')).toMatchObject({ actorUserId: owner.id, subjectUserId: memberId, actorLabel: OWNER.email });
    const warned = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, memberId), eq(notifications.kind, 'security')));
    expect(warned.map((item) => item.title)).toContain('Un administrateur a créé un lien de récupération pour votre compte.');

    const token = tokenOf(link.url);
    expect(await links.getLinkState('recovery', token, null)).toMatchObject({ kind: 'valid', email: MEMBER.email });
    await expect(links.redeemRecoveryLink(token, { password: 'court', passwordConfirmation: 'court' }, requestWith(), null)).rejects.toMatchObject({ code: 'VALIDATION' });
    await links.redeemRecoveryLink(token, { password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD }, requestWith(), null);
    expect(authErrorCode(await passwordSignIn(MEMBER.email, MEMBER.password))).toBe('INVALID_EMAIL_OR_PASSWORD');
    expect(await links.getLinkState('recovery', token, null)).toEqual({ kind: 'resume', email: MEMBER.email });
    await expect(links.resumeRecovery(token, { password: MEMBER.password }, requestWith(), null)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await enrol(MEMBER.email, NEW_PASSWORD);
    expect(await links.getLinkState('recovery', token, null)).toEqual({ kind: 'used', email: MEMBER.email });
    expect(await passwordSignIn(MEMBER.email, NEW_PASSWORD)).toMatchObject({ twoFactorRedirect: true });

    // A link not used yet, while the person enrolled a second factor again on its own (passkey
    // sign-in → /configuration/double-facteur): it has served, it never changes the password.
    const spare = await admin.createAccountRecoveryLink(owner, memberId, { password: OWNER.password });
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, memberId));
    expect(await links.getLinkState('recovery', tokenOf(spare.url), null)).toEqual({ kind: 'used', email: MEMBER.email });
    await expect(
      links.redeemRecoveryLink(tokenOf(spare.url), { password: 'Basalte-Noir-2026!', passwordConfirmation: 'Basalte-Noir-2026!' }, requestWith(), null),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const [spareRow] = await db.select({ acceptedAt: invitations.acceptedAt }).from(invitations).where(eq(invitations.tokenHash, hashToken(tokenOf(spare.url))));
    expect(spareRow!.acceptedAt).toBeNull();
    expect(authErrorCode(await passwordSignIn(MEMBER.email, 'Basalte-Noir-2026!'))).toBe('INVALID_EMAIL_OR_PASSWORD');
  });

  it("rôles : un administrateur nommé, jamais le propriétaire rétrogradé, jamais d'action sur soi-même", async () => {
    await expect(admin.changeAccountRole(owner, owner.id, { role: 'member' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const promoted = await admin.changeAccountRole(owner, memberId, { role: 'admin' });
    expect(promoted.role).toBe('admin');
    const camille: AdminActor = { id: memberId, name: MEMBER.name, email: MEMBER.email, role: 'admin' };
    await expect(admin.disableAccount(camille, memberId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(admin.changeAccountRole(camille, memberId, { role: 'member' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(admin.disableAccount(camille, owner.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(admin.deleteAccount(camille, owner.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await admin.changeAccountRole(owner, memberId, { role: 'member' })).role).toBe('member');
    expect(await lastAudit('admin.role_changed')).toMatchObject({ actorUserId: owner.id, subjectUserId: memberId });
  });
});
