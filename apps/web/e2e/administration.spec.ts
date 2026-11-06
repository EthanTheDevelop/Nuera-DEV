import type { Browser, BrowserContext, Page } from '@playwright/test';
import { createDb } from '@nuera/db';
import { auditLog, environments, spaces, user } from '@nuera/db/schema';
import { hashToken } from '@nuera/shared/tokens';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  ADMIN_ROUTES,
  COPY,
  E2E_BASE_URL,
  E2E_DATABASE_URL,
  E2E_STACK,
  E2E_STATE_FILE,
  acceptInvitation,
  adminCall,
  expect,
  invite,
  pick,
  removeAccount,
  requireAccounts,
  restartComponent,
  signIn,
  test,
  type AccountState,
} from './fixtures';
import { updateState } from './harness/state';

/**
 * ADMINISTRATION (MULTICOMPTE §6, §10, §11) — owner A in /administration, member B refused:
 *   - Comptes: every account with its role and second factor; the owner is never disabled, demoted
 *     nor deleted; a member gets 404 on the page and 403 on /api/admin/**;
 *   - Serveurs: a server is registered (token and restricted database DSN shown once), checked
 *     (« … ne répond pas » when unreachable), pre-assigned through an invitation, suspended with its
 *     account and active again when re-enabled, retired when the account is deleted;
 *   - disabling an account closes its accesses: its open browser lands on /connexion and the sign-in
 *     answers « Ce compte est désactivé. Contactez un administrateur. »;
 *   - the token of B's server is renewed: runner B restarts with the new one, the old one is refused;
 *   - Instance: the default server still has the full database DSN (warning), settings are editable;
 *   - Journal d'instance: invitations and account changes with their actors, never Git or sessions.
 * Self-restoring: B ends as it started (member, enabled, same TOTP), the throwaway account C is deleted.
 *
 *   node apps/web/e2e/harness/stack.mjs e2e --name e2e -- administration.spec.ts --project desktop
 */
requireAccounts(2);
test.skip(({ isMobile }) => isMobile, "parcours d'administration : projet « desktop »");

const database = createDb(E2E_DATABASE_URL, { max: 2, applicationName: 'e2e-administration' });
const PASSWORD = 'Granit-Rose-2026!';
let throwaway: { id: string; email: string; state: AccountState; serverId: string } | null = null;

test.afterAll(async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const owner = await ownerContext(browser);
  try {
    if (throwaway) await removeAccount(owner.request, throwaway.id);
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

async function openAdministration(page: Page, tab = '') {
  await page.goto(`${ADMIN_ROUTES.page}${tab ? `?onglet=${tab}` : ''}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Administration' }).filter({ visible: true }).first()).toBeVisible({ timeout: 120_000 });
}

test('Comptes : chaque compte avec son rôle et son double facteur ; un membre ne voit rien', async ({ page, as, stack }) => {
  await openAdministration(page);
  for (const account of stack.accounts.filter((item) => item.created)) {
    const row = page.getByRole('row', { name: new RegExp(account.email.replace(/[.+]/g, '\\$&')) }).or(page.getByRole('listitem').filter({ hasText: account.email }));
    await expect(row.first()).toBeVisible();
    await expect(row.first()).toContainText(account.key === 'a' ? 'Propriétaire' : 'Membre');
  }
  // Instance entry in the navigation (owner / admin).
  await expect(page.getByRole('link', { name: /^Administration/ }).first()).toBeVisible();

  const b = await as('b');
  const response = await b.page.goto(ADMIN_ROUTES.page);
  expect(response?.status()).toBe(404);
  for (const route of [ADMIN_ROUTES.accounts, ADMIN_ROUTES.servers, ADMIN_ROUTES.journal]) {
    expect((await b.page.request.get(route)).status(), route).toBe(403);
  }
  expect((await adminCall(b.page.request, 'POST', ADMIN_ROUTES.invitations, { email: `intrus@${E2E_STACK}.nuera.test`, role: 'member' })).status).toBe(403);
});

test('le propriétaire ne se désactive pas, ne se rétrograde pas et ne se supprime pas', async ({ page, stack }) => {
  const ownerId = stack.owner.userId!;
  for (const [method, path, data] of [
    ['POST', ADMIN_ROUTES.accountAction(ownerId, 'disable'), { stopSessions: false }],
    ['POST', ADMIN_ROUTES.accountAction(ownerId, 'role'), { role: 'member' }],
    ['DELETE', ADMIN_ROUTES.account(ownerId), undefined],
  ] as const) {
    const answer = await adminCall(page.request, method, path, data);
    expect(answer.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
    expect(answer.status, `${method} ${path}`).toBeLessThan(500);
  }
  const [owner] = await database.select({ role: user.role, disabledAt: user.disabledAt, deletedAt: user.deletedAt }).from(user).where(eq(user.id, ownerId));
  expect(owner).toEqual({ role: 'owner', disabledAt: null, deletedAt: null });
});

test("Serveurs : enregistrement (jeton et accès base affichés une fois), vérification d'un serveur injoignable", async ({ page }) => {
  const name = `VPS-E2E-${Date.now().toString(36).slice(-4).toUpperCase()}`;
  const registered = await adminCall(page.request, 'POST', ADMIN_ROUTES.servers, { name, url: 'http://127.0.0.1:9', location: 'Pile de test' });
  expect(registered.status, registered.text).toBeLessThan(300);
  const serverId = pick(registered.body, ['id', 'environmentId', 'serverId'], (text) => /^[0-9a-f-]{36}$/.test(text))!;
  const token = pick(registered.body, ['token', 'runnerToken'], (text) => text.length >= 32)!;
  const dsn = pick(registered.body, ['databaseUrl', 'dsn', 'runnerDatabaseUrl', 'databaseDsn'], (text) => /^postgres(ql)?:\/\//.test(text));
  expect(token).toMatch(/^nrt_[A-Za-z0-9_-]{43}$/);
  expect(dsn, "DSN restreint de la base pour le runner (RUNNER_DATABASE_URL)").toBeTruthy();
  // Only the fingerprint is stored; the restricted role is bound to the server.
  const [row] = await database.select().from(environments).where(eq(environments.id, serverId));
  expect(row).toMatchObject({ name, status: 'pending', spaceId: null, configSource: 'db', tokenHash: hashToken(token), isDefault: false });
  expect(row!.dbRole).toBeTruthy();
  expect(new URL(dsn!).username).toBe(row!.dbRole);
  expect(JSON.stringify(row)).not.toContain(token);
  // Shown once: listing the servers never returns the token again.
  const listed = await adminCall(page.request, 'GET', ADMIN_ROUTES.servers);
  expect(listed.text).not.toContain(token);
  expect(listed.text).toContain(name);
  // « Vérifier » an unreachable server.
  const verify = await adminCall(page.request, 'POST', ADMIN_ROUTES.serverAction(serverId, 'verify'));
  expect(verify.text).toContain(`${name} ne répond pas`);
  await openAdministration(page, 'serveurs');
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  // Retired again (never used).
  const retired = await adminCall(page.request, 'POST', ADMIN_ROUTES.serverAction(serverId, 'retire'));
  expect(retired.status, retired.text).toBeLessThan(300);
  const [after] = await database.select({ status: environments.status }).from(environments).where(eq(environments.id, serverId));
  expect(after!.status).toBe('retired');
});

test('désactiver un compte ferme ses accès et suspend son serveur ; le réactiver les rend', async ({ page, browser }) => {
  test.setTimeout(8 * 60_000);
  // A throwaway account C with its own (pending) server, pre-assigned by the invitation.
  const email = `camille.c-${Date.now().toString(36)}@${E2E_STACK}.nuera.test`;
  const registered = await adminCall(page.request, 'POST', ADMIN_ROUTES.servers, { name: `VPS-C-${Date.now().toString(36).slice(-4).toUpperCase()}`, url: 'http://127.0.0.1:9' });
  expect(registered.status, registered.text).toBeLessThan(300);
  const serverId = pick(registered.body, ['id', 'environmentId', 'serverId'], (text) => /^[0-9a-f-]{36}$/.test(text))!;
  const invitation = await invite(page.request, { email, environmentId: serverId });
  const contextC = await browser.newContext({ baseURL: E2E_BASE_URL, storageState: { cookies: [], origins: [] } });
  const pageC = await contextC.newPage();
  try {
    const state = await acceptInvitation(pageC, invitation.url, { name: 'Camille Test', email, password: PASSWORD }, { stateFile: `${test.info().outputDir}/c.json` });
    const [row] = await database.select({ id: user.id }).from(user).where(eq(user.email, email));
    throwaway = { id: row!.id, email, state, serverId };
    const [server] = await database.select({ status: environments.status, spaceId: environments.spaceId }).from(environments).where(eq(environments.id, serverId));
    expect(server!.status).toBe('active');
    expect(server!.spaceId).toBeTruthy();

    // Disable: accesses closed, sign-in refused with the exact copy, server suspended.
    const disabled = await adminCall(page.request, 'POST', ADMIN_ROUTES.accountAction(row!.id, 'disable'), { stopSessions: true });
    expect(disabled.status, disabled.text).toBeLessThan(300);
    await pageC.goto('/projets');
    await expect(pageC).toHaveURL(/\/connexion/, { timeout: 60_000 });
    await pageC.getByLabel('E-mail').fill(email);
    await pageC.getByLabel('Mot de passe').fill(PASSWORD);
    await pageC.getByRole('button', { name: 'Se connecter', exact: true }).click();
    await expect(pageC.getByText(COPY.accountDisabled)).toBeVisible({ timeout: 60_000 });
    await expect(pageC).toHaveURL(/\/connexion/);
    const [suspended] = await database.select({ status: environments.status }).from(environments).where(eq(environments.id, serverId));
    expect(suspended!.status).toBe('suspended');

    // Enable: sign-in works again, server active again.
    const enabled = await adminCall(page.request, 'POST', ADMIN_ROUTES.accountAction(row!.id, 'enable'));
    expect(enabled.status, enabled.text).toBeLessThan(300);
    const [active] = await database.select({ status: environments.status }).from(environments).where(eq(environments.id, serverId));
    expect(active!.status).toBe('active');
    await signIn(pageC, state, { stateFile: `${test.info().outputDir}/c.json` });
    await expect(pageC).not.toHaveURL(/\/connexion/);

    // Delete (only once disabled): anonymised, space archived, server retired.
    expect((await adminCall(page.request, 'DELETE', ADMIN_ROUTES.account(row!.id))).status).toBeGreaterThanOrEqual(400);
    await adminCall(page.request, 'POST', ADMIN_ROUTES.accountAction(row!.id, 'disable'), { stopSessions: true });
    const deleted = await adminCall(page.request, 'DELETE', ADMIN_ROUTES.account(row!.id));
    expect(deleted.status, deleted.text).toBeLessThan(300);
    const [gone] = await database.select({ deletedAt: user.deletedAt }).from(user).where(eq(user.id, row!.id));
    expect(gone!.deletedAt).not.toBeNull();
    const [retired] = await database.select({ status: environments.status, spaceId: environments.spaceId }).from(environments).where(eq(environments.id, serverId));
    expect(retired!.status).toBe('retired');
    const [space] = await database.select({ archivedAt: spaces.archivedAt }).from(spaces).where(eq(spaces.id, server!.spaceId!));
    expect(space!.archivedAt).not.toBeNull();
    throwaway = null;
  } finally {
    await contextC.close();
  }
});

test("Serveurs : attribution d'un serveur jamais utilisé, gardes de la promesse d'invitation et du serveur déjà attribué", async ({ page, browser, stack }) => {
  test.setTimeout(6 * 60_000);
  const runnerB = stack.runners.find((runner) => runner.key === 'b')!;
  const userB = stack.accounts.find((account) => account.key === 'b')!.userId!;
  const name = `VPS-A-${Date.now().toString(36).slice(-4).toUpperCase()}`;
  const registered = await adminCall(page.request, 'POST', ADMIN_ROUTES.servers, { name, url: 'http://127.0.0.1:9' });
  expect(registered.status, registered.text).toBeLessThan(300);
  const serverId = pick(registered.body, ['id'], (text) => /^[0-9a-f-]{36}$/.test(text))!;

  // Promised to an invitation in progress: never taken from the person invited.
  const promisedTo = `promis-${Date.now().toString(36)}@${E2E_STACK}.nuera.test`;
  const promise = await invite(page.request, { email: promisedTo, environmentId: serverId });
  const promised = await adminCall(page.request, 'POST', ADMIN_ROUTES.serverAction(serverId, 'assign'), { userId: userB });
  expect(promised.status).toBe(409);
  expect(promised.body).toMatchObject({ error: { message: `Ce serveur est promis à l'invitation adressée à ${promisedTo} : annulez-la d'abord.` } });
  expect((await adminCall(page.request, 'DELETE', ADMIN_ROUTES.invitation(promise.id!))).status).toBe(204);

  // One server per space: B keeps « VPS-4 », the new server stays pending.
  const taken = await adminCall(page.request, 'POST', ADMIN_ROUTES.serverAction(serverId, 'assign'), { userId: userB });
  expect(taken.status).toBe(409);
  expect(taken.body).toMatchObject({ error: { message: `Ce compte a déjà un serveur (${runnerB.name}) : retirez-le d'abord.` } });
  const [stillPending] = await database.select({ status: environments.status, spaceId: environments.spaceId }).from(environments).where(eq(environments.id, serverId));
  expect(stillPending).toEqual({ status: 'pending', spaceId: null });

  // An account invited without a server shows « Aucun serveur attribué », then gets this one.
  const email = `sans-serveur-${Date.now().toString(36)}@${E2E_STACK}.nuera.test`;
  const invitation = await invite(page.request, { email });
  const context = await browser.newContext({ baseURL: E2E_BASE_URL, storageState: { cookies: [], origins: [] } });
  let accountId: string | null = null;
  try {
    const guest = await context.newPage();
    await acceptInvitation(guest, invitation.url, { name: 'Inès Test', email, password: PASSWORD }, { stateFile: `${test.info().outputDir}/sans-serveur.json` });
    const [row] = await database.select({ id: user.id }).from(user).where(eq(user.email, email));
    accountId = row!.id;
    await guest.goto('/projets');
    await expect(guest.getByText(COPY.noServer).first()).toBeVisible({ timeout: 120_000 });

    const assigned = await adminCall(page.request, 'POST', ADMIN_ROUTES.serverAction(serverId, 'assign'), { userId: accountId });
    expect(assigned.status, assigned.text).toBe(200);
    const [server] = await database.select({ status: environments.status, spaceId: environments.spaceId }).from(environments).where(eq(environments.id, serverId));
    const [space] = await database.select({ id: spaces.id }).from(spaces).where(eq(spaces.ownerUserId, accountId));
    expect(server).toEqual({ status: 'active', spaceId: space!.id });
    const [journal] = await database.select({ actor: auditLog.actorUserId, subject: auditLog.subjectUserId }).from(auditLog).where(and(eq(auditLog.action, 'admin.server_assigned'), eq(auditLog.targetId, serverId)));
    expect(journal).toEqual({ actor: stack.owner.userId, subject: accountId });
    // Its server from now on (unreachable here: « … ne répond pas », never « Aucun serveur attribué »).
    await guest.goto('/projets');
    await expect(guest.getByText(name, { exact: false }).filter({ visible: true }).first()).toBeVisible({ timeout: 120_000 });
    await expect(guest.getByText(COPY.noServer)).toHaveCount(0);

    // A server already used is never assigned again.
    const again = await adminCall(page.request, 'POST', ADMIN_ROUTES.serverAction(serverId, 'assign'), { userId: accountId });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { message: 'Seul un serveur jamais utilisé peut être attribué : retirez celui-ci et enregistrez-en un nouveau.' } });
  } finally {
    await context.close();
    if (accountId) await removeAccount(page.request, accountId);
    else await adminCall(page.request, 'POST', ADMIN_ROUTES.serverAction(serverId, 'retire')).catch(() => undefined);
  }
  const [retired] = await database.select({ status: environments.status }).from(environments).where(eq(environments.id, serverId));
  expect(retired!.status).toBe('retired');
});

test("le jeton du serveur de B est renouvelé : son runner repart avec le nouveau, l'ancien est refusé", async ({ page, stack }) => {
  test.setTimeout(6 * 60_000);
  const runnerB = stack.runners.find((runner) => runner.key === 'b')!;
  const oldToken = runnerB.token;
  const rotated = await adminCall(page.request, 'POST', ADMIN_ROUTES.serverAction(runnerB.environmentId!, 'rotate'));
  expect(rotated.status, rotated.text).toBeLessThan(300);
  const newToken = pick(rotated.body, ['token', 'runnerToken'], (text) => text.length >= 32)!;
  expect(newToken).toMatch(/^nrt_/);
  expect(newToken).not.toBe(oldToken);
  // The stack keeps the new token (as the person who deploys the server would), runner B restarts.
  updateState(E2E_STATE_FILE, (state) => {
    state.runners.find((runner) => runner.key === 'b')!.token = newToken;
  });
  await restartComponent('runner-b');
  const health = await fetch(`${runnerB.urls.runner}/v1/health`, { headers: { authorization: `Bearer ${newToken}` } });
  expect(health.status).toBe(200);
  // The first call of the runner with the new token promotes it; the old one is then refused.
  // (A read credential for one of B's projects: a runner → web call without side effect.)
  const projectOfB = stack.accounts.find((account) => account.key === 'b')!.seeded?.projects?.devis?.id;
  expect(projectOfB, 'projet du compte b (seed --as b projects)').toBeTruthy();
  const internal = (token: string) =>
    fetch(`${stack.urls.web}/api/internal/git-credentials`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: projectOfB, access: 'read' }) });
  expect((await internal(newToken)).status).toBe(200);
  await expect.poll(async () => (await internal(oldToken)).status, { timeout: 60_000 }).toBe(401);
  const [row] = await database.select({ tokenHash: environments.tokenHash, nextTokenHash: environments.nextTokenHash }).from(environments).where(eq(environments.id, runnerB.environmentId!));
  expect([row!.tokenHash, row!.nextTokenHash]).toContain(hashToken(newToken));
  expect([row!.tokenHash, row!.nextTokenHash]).not.toContain(hashToken(oldToken));
});

test("Instance et journal : réglages de l'instance, avertissement du serveur par défaut, journal sans contenu d'espace", async ({ page, as, stack }) => {
  const serverA = stack.runners.find((runner) => runner.key === 'a')!;
  // Instance settings: the owner changes one (and puts it back), a member is refused on both routes.
  const instance = await adminCall(page.request, 'GET', '/api/admin/instance');
  expect(instance.status, instance.text).toBe(200);
  const ttl = (instance.body as { settings: { invitationTtlHours: number } }).settings.invitationTtlHours;
  const changed = ttl === 72 ? 48 : 72;
  try {
    const patched = await adminCall(page.request, 'PATCH', '/api/admin/instance', { invitationTtlHours: changed });
    expect(patched.status, patched.text).toBe(200);
    expect(((await adminCall(page.request, 'GET', '/api/admin/instance')).body as { settings: { invitationTtlHours: number } }).settings.invitationTtlHours).toBe(changed);
    const b = await as('b');
    expect((await adminCall(b.page.request, 'PATCH', '/api/admin/instance', { invitationTtlHours: 1 })).status).toBe(403);
    const refused = await adminCall(b.page.request, 'PATCH', '/api/settings', { invitationTtlHours: 1 });
    expect(refused.status, refused.text).toBe(403);
    expect(refused.body).toMatchObject({ error: { message: COPY.instanceSettingReserved } });
    expect(((await adminCall(page.request, 'GET', '/api/admin/instance')).body as { settings: { invitationTtlHours: number } }).settings.invitationTtlHours).toBe(changed);
  } finally {
    await adminCall(page.request, 'PATCH', '/api/admin/instance', { invitationTtlHours: ttl });
  }
  await openAdministration(page, 'instance');
  // Runner A still connects with the full DSN of the instance (no RUNNER_DATABASE_URL on the stack).
  await openAdministration(page, 'serveurs');
  await expect(page.getByText(COPY.defaultServerFullDatabase(serverA.name)).filter({ visible: true }).first()).toBeVisible();

  await openAdministration(page, 'journal');
  const journal = await adminCall(page.request, 'GET', ADMIN_ROUTES.journal);
  expect(journal.status, journal.text).toBe(200);
  const actions = (JSON.stringify(journal.body).match(/"action":"([a-z_.]+)"/g) ?? []).map((item) => item.slice('"action":"'.length, -1));
  expect(actions.filter((action) => /^(git|project|session|terminal)\./.test(action))).toEqual([]);
  // The administration's own actions are journaled with their actor (the owner).
  const rows = await database
    .select({ action: auditLog.action, actor: auditLog.actorUserId })
    .from(auditLog)
    .where(and(eq(auditLog.actorUserId, stack.owner.userId!), inArray(auditLog.action, ['admin.invitation_created', 'admin.account_disabled', 'admin.account_enabled', 'admin.server_registered'])))
    .orderBy(desc(auditLog.id))
    .limit(20);
  expect(rows.length).toBeGreaterThan(0);
});
