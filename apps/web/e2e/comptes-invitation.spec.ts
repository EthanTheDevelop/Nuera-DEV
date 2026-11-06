import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { createDb } from '@nuera/db';
import { auditLog, environments, invitations, spaceMembers, user } from '@nuera/db/schema';
import { hashToken } from '@nuera/shared/tokens';
import { desc, eq } from 'drizzle-orm';
import {
  ADMIN_ROUTES,
  COPY,
  E2E_BASE_URL,
  E2E_DATABASE_URL,
  E2E_STACK,
  adminCall,
  completeEnrolment,
  expect,
  invite,
  removeAccount,
  signIn,
  signOut,
  test,
  type AccountState,
} from './fixtures';

/**
 * COMPTES — invitation and mandatory second factor (MULTICOMPTE §6), through the real pages:
 *   - the owner invites an address (administration route); the link /invitation/<jeton> is single use;
 *   - the invited person chooses a password (the e-mail is the invited one, read-only), then
 *     « Activation de votre compte »: TOTP is mandatory (nothing else is reachable before), 8 backup
 *     codes, passkey later; the account gets its personal space (no server unless one was assigned);
 *   - the link resumes an interrupted activation with the chosen password, until the 2FA is enrolled;
 *   - used, expired, revoked and unknown links are refused without the form; public sign-up stays closed;
 *   - signed in as another account, the link asks to sign out first;
 *   - the new account signs out and back in (TOTP, backup code); the journals record the invitation.
 * Throwaway accounts are disabled and deleted at the end (administration).
 *
 *   node apps/web/e2e/harness/stack.mjs e2e --name e2e -- comptes-invitation.spec.ts --project desktop
 */
test.skip(({ isMobile }) => isMobile, 'parcours de comptes : projet « desktop » (ses contextes sont les siens)');

const database = createDb(E2E_DATABASE_URL, { max: 2, applicationName: 'e2e-comptes' });
const created: string[] = [];
const PASSWORD = 'Ardoise-Claire-2026!';

test.afterAll(async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const owner = await ownerContext(browser);
  try {
    for (const id of created) await removeAccount(owner.request, id);
  } finally {
    await owner.close();
  }
  await database.$client.end({ timeout: 5 });
});

async function ownerContext(browser: Browser): Promise<BrowserContext> {
  const { stackState } = await import('./fixtures');
  const state = await stackState();
  return browser.newContext({ baseURL: E2E_BASE_URL, storageState: state.accounts.find((account) => account.key === 'a')!.storageState });
}

function newAddress(label: string): string {
  return `${label}-${Date.now().toString(36)}@${E2E_STACK}.nuera.test`;
}

async function visitor(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: E2E_BASE_URL, storageState: { cookies: [], origins: [] }, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  return { context, page: await context.newPage() };
}

/** Fills the invitation form (password chosen twice) and submits it. */
async function choosePassword(page: Page, name: string, password = PASSWORD) {
  const nameField = page.getByLabel('Nom', { exact: true });
  if (await nameField.isVisible().catch(() => false)) await nameField.fill(name);
  await page.getByLabel('Mot de passe', { exact: true }).fill(password);
  await page.getByLabel('Confirmer le mot de passe').fill(password);
  await page.getByRole('button', { name: /^Créer (mon|le) compte$/ }).click();
}

async function userIdOf(email: string): Promise<string | null> {
  const [row] = await database.select({ id: user.id }).from(user).where(eq(user.email, email.toLowerCase()));
  return row?.id ?? null;
}

test('lien inconnu : expliqué, sans formulaire ni indice', async ({ browser }) => {
  const { context, page } = await visitor(browser);
  try {
    await page.goto(`/invitation/${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 11)}`);
    await expect(page.getByText(COPY.invitationUnusable).first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByLabel('Mot de passe', { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("invitation acceptée : mot de passe, double facteur obligatoire, codes de secours, puis l'accueil de son espace", async ({ browser, page, stack }) => {
  test.setTimeout(6 * 60_000);
  const email = newAddress('nadia');
  const invitation = await invite(page.request, { email });
  // Stored hashed only: the token itself is nowhere in the database.
  const [row] = await database.select().from(invitations).where(eq(invitations.tokenHash, hashToken(invitation.token)));
  expect(row).toMatchObject({ kind: 'invite', email, role: 'member', acceptedAt: null });
  expect(JSON.stringify(row)).not.toContain(invitation.token);

  const { context, page: guest } = await visitor(browser);
  try {
    await guest.goto(invitation.url);
    const emailField = guest.getByLabel('E-mail');
    await expect(emailField).toHaveValue(email, { timeout: 120_000 });
    await expect(emailField).not.toBeEditable();
    // Weak password refused field by field, nothing created.
    await choosePassword(guest, 'Nadia Lefèvre', 'court');
    await expect(guest.getByLabel('Mot de passe', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    expect(await userIdOf(email)).toBeNull();

    await choosePassword(guest, 'Nadia Lefèvre');
    await expect(guest.getByTestId('totp-manual-key')).toBeVisible({ timeout: 120_000 });
    const id = await userIdOf(email);
    expect(id).toBeTruthy();
    created.push(id!);
    // TOTP is mandatory: the application is not reachable before the enrolment.
    await guest.goto('/');
    await expect(guest).not.toHaveURL(/\/$/);
    await expect(guest.getByRole('heading', { level: 1, name: /^Bonjour/ })).toHaveCount(0);
    await guest.goto(invitation.url);
    let state: AccountState | null = null;
    if (await guest.getByLabel('Mot de passe', { exact: true }).isVisible().catch(() => false)) {
      await guest.getByLabel('Mot de passe', { exact: true }).fill(PASSWORD);
      await guest.getByRole('button', { name: /^(Continuer|Reprendre l'activation|Se connecter)$/ }).click();
    }
    await completeEnrolment(guest, (totpSecret, backupCodes) => {
      state = { name: 'Nadia Lefèvre', email, password: PASSWORD, totpSecret, backupCodes };
    });
    await expect(guest.getByRole('heading', { level: 1 })).toHaveText('Bonjour Nadia', { timeout: 120_000 });

    // Member of its own personal space, no server yet (none was assigned): never the owner's server.
    const [account] = await database.select({ role: user.role, twoFactorEnabled: user.twoFactorEnabled }).from(user).where(eq(user.id, id!));
    expect(account).toMatchObject({ role: 'member', twoFactorEnabled: true });
    const [membership] = await database.select({ spaceId: spaceMembers.spaceId }).from(spaceMembers).where(eq(spaceMembers.userId, id!));
    expect(membership!.spaceId).not.toBe(stack.accounts.find((item) => item.key === 'a')!.spaceId);
    expect(await database.select({ id: environments.id }).from(environments).where(eq(environments.spaceId, membership!.spaceId))).toHaveLength(0);
    await guest.goto('/projets');
    await expect(guest.getByText(COPY.noServer).first()).toBeVisible({ timeout: 120_000 });
    await expect(guest.getByText(stack.runners.find((runner) => runner.key === 'a')!.name, { exact: true })).toHaveCount(0);

    // Sign out, then back in with TOTP, then with a backup code.
    await signOut(guest);
    await guest.waitForTimeout((30 - (Math.floor(Date.now() / 1000) % 30) + 1) * 1000);
    await signIn(guest, state!, { stateFile: `${test.info().outputDir}/nadia.json` });
    await expect(guest).not.toHaveURL(/\/connexion/);
    await signOut(guest);
    await signIn(guest, state!, { method: 'backup', stateFile: `${test.info().outputDir}/nadia.json` });
    await expect(guest).not.toHaveURL(/\/connexion/);

    // The link has served: refused, without the form.
    await signOut(guest);
    await guest.goto(invitation.url);
    await expect(guest.getByText(COPY.invitationUnusable).first()).toBeVisible({ timeout: 60_000 });
    await expect(guest.getByLabel('Confirmer le mot de passe')).toHaveCount(0);

    // Journals: the invitation and its acceptance, with their actors.
    const rows = await database.select({ action: auditLog.action, actor: auditLog.actorUserId, subject: auditLog.subjectUserId }).from(auditLog).where(eq(auditLog.subjectUserId, id!)).orderBy(desc(auditLog.id));
    expect(rows.map((item) => item.action)).toEqual(expect.arrayContaining([expect.stringMatching(/invitation/)]));
  } finally {
    await context.close();
  }
});

test("une activation interrompue reprend par le même lien, avec le mot de passe choisi", async ({ browser, page }) => {
  test.setTimeout(5 * 60_000);
  const email = newAddress('yanis');
  const invitation = await invite(page.request, { email });
  const first = await visitor(browser);
  try {
    await first.page.goto(invitation.url);
    await choosePassword(first.page, 'Yanis Bernard');
    await expect(first.page.getByTestId('totp-manual-key')).toBeVisible({ timeout: 120_000 });
    const id = await userIdOf(email);
    created.push(id!);
  } finally {
    // The browser is closed before the second factor.
    await first.context.close();
  }
  const second = await visitor(browser);
  try {
    await second.page.goto(invitation.url);
    // A wrong password does not resume.
    await second.page.getByLabel('Mot de passe', { exact: true }).fill('Mauvais-Mot-2026!');
    await second.page.getByRole('button', { name: /^(Continuer|Reprendre l'activation|Se connecter)$/ }).click();
    await expect(second.page.getByRole('alert').first()).toBeVisible({ timeout: 60_000 });
    await expect(second.page.getByTestId('totp-manual-key')).toHaveCount(0);
    // The refused form is re-rendered by its server action: start again from the link.
    await second.page.goto(invitation.url);
    await expect(second.page.getByRole('heading', { name: "Reprendre l'activation" })).toBeVisible({ timeout: 60_000 });
    await second.page.getByLabel('Mot de passe', { exact: true }).fill(PASSWORD);
    await expect(second.page.getByLabel('Mot de passe', { exact: true })).toHaveValue(PASSWORD);
    await second.page.getByRole('button', { name: /^(Continuer|Reprendre l'activation|Se connecter)$/ }).click();
    await completeEnrolment(second.page, () => undefined);
    await expect(second.page.getByRole('heading', { level: 1 })).toHaveText('Bonjour Yanis', { timeout: 120_000 });
    const [row] = await database.select({ completedAt: invitations.completedAt }).from(invitations).where(eq(invitations.tokenHash, hashToken(invitation.token)));
    expect(row!.completedAt).not.toBeNull();
  } finally {
    await second.context.close();
  }
});

test('liens expiré et annulé : refusés sans formulaire, aucun compte créé', async ({ browser, page }) => {
  const expiredEmail = newAddress('expire');
  const expired = await invite(page.request, { email: expiredEmail });
  await database.update(invitations).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(invitations.tokenHash, hashToken(expired.token)));
  const revokedEmail = newAddress('annule');
  const revoked = await invite(page.request, { email: revokedEmail });
  const [row] = await database.select({ id: invitations.id }).from(invitations).where(eq(invitations.tokenHash, hashToken(revoked.token)));
  const cancel = await adminCall(page.request, 'DELETE', ADMIN_ROUTES.invitation(revoked.id ?? row!.id));
  expect(cancel.status, cancel.text).toBeLessThan(300);

  const { context, page: guest } = await visitor(browser);
  try {
    for (const [link, email] of [
      [expired.url, expiredEmail],
      [revoked.url, revokedEmail],
    ] as const) {
      await guest.goto(link);
      await expect(guest.getByText(COPY.invitationUnusable).first()).toBeVisible({ timeout: 120_000 });
      await expect(guest.getByLabel('Confirmer le mot de passe')).toHaveCount(0);
      expect(await userIdOf(email)).toBeNull();
    }
  } finally {
    await context.close();
  }
});

test("connecté avec un autre compte, le lien demande d'abord de se déconnecter", async ({ page }) => {
  const invitation = await invite(page.request, { email: newAddress('deja-connecte') });
  await page.goto(invitation.url);
  await expect(page.getByText(COPY.otherAccountSignedIn)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByLabel('Confirmer le mot de passe')).toHaveCount(0);
  const [row] = await database.select({ id: invitations.id }).from(invitations).where(eq(invitations.tokenHash, hashToken(invitation.token)));
  await adminCall(page.request, 'DELETE', ADMIN_ROUTES.invitation(invitation.id ?? row!.id));
});

test("l'invitation d'un compte qui existe déjà est refusée, et un membre ne peut pas inviter", async ({ page, as, stack }) => {
  const existing = stack.accounts.find((account) => account.key === 'b' && account.created);
  if (existing) {
    const answer = await adminCall(page.request, 'POST', ADMIN_ROUTES.invitations, { email: existing.email, role: 'member' });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    const b = await as('b');
    const refused = await adminCall(b.page.request, 'POST', ADMIN_ROUTES.invitations, { email: newAddress('par-un-membre'), role: 'member' });
    expect([403, 404]).toContain(refused.status);
  }
});
