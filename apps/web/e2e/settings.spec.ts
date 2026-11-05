import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { createDb } from '@nuera/db';
import { appSettings, auditLog, worktrees } from '@nuera/db/schema';
import { and, desc, eq, like } from 'drizzle-orm';
import { E2E_BASE_URL, E2E_DATABASE_URL, expect, readOwnerState, signIn, test, writeOwnerState } from './fixtures';

/**
 * Lot PARAMÈTRES — D08 (desktop tabs) / M08 (phone groups + drill-downs) against the real test
 * stack: runner (fake CLI), database, Better Auth. Run with:
 *
 *   E2E_STACK=settings pnpm --filter @nuera/web e2e settings.spec.ts
 *
 * Every test puts back what it changed (settings, Claude login, owner backup codes).
 */
test.describe.configure({ mode: 'serial' });

const isMobile = () => test.info().project.name === 'mobile';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const database = createDb(E2E_DATABASE_URL, { max: 2, applicationName: 'e2e-settings' });
test.afterAll(async () => {
  await database.$client.end({ timeout: 5 });
});

async function openSettings(page: Page, query = '') {
  await page.goto(`/parametres${query}`);
  await expect(page.getByRole('heading', { level: 1 }).filter({ visible: true }).first()).toBeVisible({ timeout: 120_000 });
}

function toast(page: Page, message: string): Locator {
  return page.getByText(message, { exact: true }).first();
}

async function patchSettings(page: Page, patch: Record<string, unknown>) {
  const response = await page.request.patch('/api/settings', { data: patch, headers: { origin: E2E_BASE_URL } });
  expect(response.status(), await response.text()).toBe(200);
}

async function readSettings() {
  const [row] = await database.select().from(appSettings).where(eq(appSettings.id, 1));
  return row!;
}

test.describe("vue d'ensemble", () => {
  test('montre les vraies données du CLI, du compte et du serveur', async ({ page }) => {
    await openSettings(page);
    if (isMobile()) {
      await expect(page.getByText('Un seul propriétaire : Camille', { exact: true })).toBeVisible();
      for (const group of ['Claude Code', 'Sécurité', 'Serveur VPS-3', 'Préférences']) {
        await expect(page.getByRole('heading', { name: group, exact: true })).toBeVisible();
      }
      await expect(page.getByRole('button', { name: /Compte Claude.*Connecté · Max/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /Mode de permission.*Demander/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /Double facteur.*Actif/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /État.*En ligne/ })).toBeVisible();
      await expect(page.getByText("Nuera Dev ne stocke aucun identifiant Claude et n'estime aucun coût.", { exact: true })).toBeVisible();
      // No horizontal page scroll at 390 px.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      return;
    }
    await expect(page.getByText('Compte, sécurité, Claude Code et serveur. Un seul propriétaire, aucun autre compte.', { exact: true })).toBeVisible();
    const claude = page.getByRole('region', { name: 'Claude Code · compte Claude' });
    await expect(claude.getByText('Connecté · formule Max', { exact: true })).toBeVisible();
    await expect(claude.getByRole('combobox', { name: 'Modèle par défaut' })).toHaveText(/Défaut du CLI/);
    await expect(claude.getByRole('combobox', { name: 'Mode de permission' })).toHaveText(/Demander avant d'agir/);
    await expect(claude.getByRole('switch', { name: 'Bloquer le mode sans autorisation' })).toBeChecked();
    const security = page.getByRole('region', { name: 'Compte et sécurité' });
    await expect(security.getByText('Actif', { exact: true })).toBeVisible();
    await expect(security.getByText(/codes? de secours restants?/)).toBeVisible();
    await expect(security.getByText('Cet appareil', { exact: true })).toBeVisible();
    await expect(security.getByText("Un accès expire après 12 h d'inactivité, et au plus tard après 30 jours.", { exact: true })).toBeVisible();
    const server = page.getByRole('region', { name: 'Serveur VPS-3' });
    await expect(server.getByText('En ligne', { exact: true })).toBeVisible();
    await expect(server.getByText(/processus PTY|processus tmux/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Maintenance' }).getByRole('button', { name: 'Consulter' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Préférences' }).getByRole('combobox', { name: 'Thème' })).toHaveText(/Clair/);
  });

  test("les onglets vivent dans l'URL (précédent / suivant) ou en pages au téléphone", async ({ page }) => {
    await openSettings(page);
    if (isMobile()) {
      await page.getByRole('button', { name: /Compte Claude/ }).click();
      await expect(page).toHaveURL(/onglet=claude-code/);
      await expect(page.getByRole('heading', { level: 1, name: 'Claude Code' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'État du CLI' })).toBeVisible();
      await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
      await expect(page).not.toHaveURL(/onglet=/);
      await page.getByRole('button', { name: /Accès ouverts/ }).click();
      await expect(page).toHaveURL(/onglet=compte-et-securite/);
      await expect(page.getByRole('region', { name: 'Accès ouverts' })).toBeVisible();
      await page.goBack();
      await expect(page.getByRole('heading', { name: 'Sécurité', exact: true })).toBeVisible();
      return;
    }
    await page.getByRole('tab', { name: 'Serveur' }).click();
    await expect(page).toHaveURL(/onglet=serveur/);
    await expect(page.getByRole('region', { name: 'Réglages du serveur' })).toBeVisible();
    await page.getByRole('tab', { name: 'Compte et sécurité' }).click();
    await expect(page).toHaveURL(/onglet=compte-et-securite/);
    await page.goBack();
    await expect(page.getByRole('tab', { name: 'Serveur' })).toHaveAttribute('aria-selected', 'true');
    await page.goBack();
    await expect(page.getByRole('tab', { name: "Vue d'ensemble" })).toHaveAttribute('aria-selected', 'true');
    // « Tout voir » leads to the full security journal.
    await page.getByRole('button', { name: 'Tout voir' }).click();
    await expect(page).toHaveURL(/onglet=compte-et-securite#journal-de-securite/);
    await expect(page.getByRole('region', { name: 'Journal de sécurité' }).getByText(/connexion/).first()).toBeVisible();
  });
});

test.describe('Claude Code', () => {
  test("le mode de permission par défaut s'enregistre (toast, audit, rechargement)", async ({ page }) => {
    await openSettings(page);
    try {
      if (isMobile()) {
        await page.getByRole('button', { name: /Mode de permission/ }).click();
        const sheet = page.getByRole('dialog', { name: 'Mode de permission' });
        await expect(sheet.getByRole('radio', { name: /Demander avant d'agir/ })).toHaveAttribute('aria-checked', 'true');
        await expect(sheet.getByRole('radio', { name: /Sans autorisation/ })).toHaveCount(0);
        await sheet.getByRole('radio', { name: /Accepter les modifications/ }).click();
      } else {
        await page.getByRole('combobox', { name: 'Mode de permission' }).click();
        await expect(page.getByRole('option', { name: /Sans autorisation/ })).toHaveCount(0);
        await page.getByRole('option', { name: /Accepter les modifications/ }).click();
      }
      await expect(toast(page, 'Mode de permission par défaut : accepter les modifications')).toBeVisible();
      await expect.poll(async () => (await readSettings()).defaultPermissionMode).toBe('acceptEdits');
      const [audit] = await database.select().from(auditLog).where(eq(auditLog.action, 'settings.updated')).orderBy(desc(auditLog.id)).limit(1);
      expect(audit!.summary).toBe('réglages modifiés : mode de permission');
      await page.reload();
      if (isMobile()) await expect(page.getByRole('button', { name: /Mode de permission.*Accepter/ })).toBeVisible();
      else await expect(page.getByRole('combobox', { name: 'Mode de permission' })).toHaveText(/Accepter les modifications/);
    } finally {
      await patchSettings(page, { defaultPermissionMode: 'manual' });
    }
  });

  test('lever le blocage du mode sans autorisation demande confirmation (T8)', async ({ page }) => {
    test.skip(isMobile(), 'interrupteur du bureau');
    await openSettings(page, '?onglet=claude-code');
    try {
      const guard = page.getByRole('switch', { name: 'Bloquer le mode sans autorisation' });
      await guard.click();
      const dialog = page.getByRole('alertdialog', { name: 'Lever le blocage du mode sans autorisation ?' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Annuler' }).click();
      await expect(guard).toBeChecked();
      expect((await readSettings()).blockBypassPermissions).toBe(true);
      await guard.click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Lever le blocage' }).click();
      await expect(toast(page, 'Blocage du mode sans autorisation levé')).toBeVisible();
      await expect(guard).not.toBeChecked();
      await page.getByRole('combobox', { name: 'Mode de permission' }).click();
      await expect(page.getByRole('option', { name: /Sans autorisation/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await guard.click();
      await expect(toast(page, 'Mode sans autorisation bloqué')).toBeVisible();
      await expect.poll(async () => (await readSettings()).blockBypassPermissions).toBe(true);
    } finally {
      await patchSettings(page, { blockBypassPermissions: true, defaultPermissionMode: 'manual' });
    }
  });

  test("T6 : la reconnexion ouvre le terminal claude auth login et l'état se rafraîchit", async ({ page, cli }) => {
    await cli.setLoggedIn(false);
    try {
      await page.goto('/parametres?onglet=claude-code&action=reconnexion');
      const dialog = page.getByRole('dialog', { name: 'Connexion à Claude Code' });
      await expect(dialog).toBeVisible({ timeout: 120_000 });
      await expect(page).not.toHaveURL(/action=reconnexion/);
      const terminal = dialog.locator('[data-terminal-state]');
      await expect(terminal).toHaveAttribute('data-terminal-state', 'live', { timeout: 90_000 });
      await expect(terminal.locator('.xterm-rows')).toContainText('Paste code here', { timeout: 30_000 });
      await terminal.locator('.xterm-screen').click();
      await page.keyboard.type('code-de-test', { delay: 10 });
      await page.keyboard.press('Enter');
      await expect(terminal).toHaveAttribute('data-terminal-state', 'exited', { timeout: 30_000 });
      await dialog.getByRole('button', { name: 'Fermer' }).first().click();
      if (isMobile()) await expect(page.getByRole('region', { name: 'État du CLI' }).getByText('oui', { exact: true })).toBeVisible({ timeout: 30_000 });
      else await expect(page.getByRole('region', { name: 'Claude Code · compte Claude' }).getByText('Connecté · formule Max', { exact: true })).toBeVisible({ timeout: 30_000 });
      const [audit] = await database.select().from(auditLog).where(like(auditLog.action, 'terminal.%')).orderBy(desc(auditLog.id)).limit(1);
      expect(audit).toBeTruthy();
    } finally {
      await cli.setLoggedIn(true);
    }
  });

  test('« Ouvrir /status » ouvre le CLI officiel dans un terminal', async ({ page }) => {
    await openSettings(page);
    if (isMobile()) await page.getByRole('button', { name: /Utilisation.*Ouvrir \/status/ }).click();
    else await page.getByRole('region', { name: 'Claude Code · compte Claude' }).getByRole('button', { name: 'Ouvrir /status' }).click();
    const dialog = page.getByRole('dialog', { name: 'Claude Code · /status' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-terminal-state]')).toHaveAttribute('data-terminal-state', 'live', { timeout: 90_000 });
    await dialog.getByRole('button', { name: 'Fermer' }).first().click();
    await expect(dialog).toBeHidden();
  });
});

test.describe('Compte et sécurité', () => {
  test('un autre accès se révoque après confirmation (T8)', async ({ page, browser }) => {
    test.skip(isMobile(), 'une fois suffit');
    const owner = readOwnerState()!;
    const other = await browser.newContext({ baseURL: E2E_BASE_URL, userAgent: IPHONE_UA, storageState: { cookies: [], origins: [] } });
    const otherPage = await other.newPage();
    // A TOTP code is single-use: wait for the next window if the worker just used this one.
    await new Promise((resolve) => setTimeout(resolve, (30 - (Math.floor(Date.now() / 1000) % 30) + 1) * 1000));
    await signIn(otherPage, owner);
    try {
      await openSettings(page, '?onglet=compte-et-securite');
      const access = page.getByRole('region', { name: 'Accès ouverts' });
      await access.getByRole('button', { name: 'Révoquer iPhone · Safari' }).first().click();
      const dialog = page.getByRole('alertdialog', { name: "Révoquer l'accès « iPhone · Safari » ?" });
      await dialog.getByRole('button', { name: 'Révoquer' }).click();
      await expect(toast(page, 'Accès révoqué : iPhone · Safari')).toBeVisible();
      await expect(access.getByRole('button', { name: 'Révoquer iPhone · Safari' })).toHaveCount(0);
      await otherPage.goto('/parametres');
      await expect(otherPage).toHaveURL(/\/connexion/);
    } finally {
      await other.close();
    }
  });

  test("les codes de secours se régénèrent avec le mot de passe et ne s'affichent qu'une fois", async ({ page }) => {
    test.skip(isMobile(), 'une fois suffit');
    const owner = readOwnerState()!;
    await openSettings(page, '?onglet=compte-et-securite');
    await page.getByRole('button', { name: 'Régénérer les codes de secours' }).click();
    const dialog = page.getByRole('dialog', { name: 'Régénérer les codes de secours' });
    await dialog.getByLabel('Mot de passe').fill('mauvais-mot-de-passe');
    await dialog.getByRole('button', { name: 'Régénérer' }).click();
    await expect(dialog.getByText('Mot de passe actuel incorrect.')).toBeVisible();
    await dialog.getByLabel('Mot de passe').fill(owner.password);
    await dialog.getByRole('button', { name: 'Régénérer' }).click();
    const codes = page.getByTestId('backup-codes').locator('li');
    await expect(codes).toHaveCount(8);
    owner.backupCodes = (await codes.allInnerTexts()).map((code) => code.trim());
    writeOwnerState(owner);
    await page.getByRole('button', { name: "J'ai conservé mes codes" }).click();
    await expect(page.getByRole('region', { name: 'Double facteur' }).getByText('8 codes de secours restants')).toBeVisible();
    const [audit] = await database.select().from(auditLog).where(eq(auditLog.action, 'auth.backup_codes_regenerated')).orderBy(desc(auditLog.id)).limit(1);
    expect(audit).toBeTruthy();
  });

  test("une clé d'accès s'ajoute, se renomme et se supprime", async ({ page }) => {
    test.skip(isMobile(), 'authentificateur virtuel du bureau');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    try {
      await openSettings(page, '?onglet=compte-et-securite');
      const tile = page.getByRole('region', { name: "Clés d'accès" });
      await tile.getByRole('button', { name: "Ajouter une clé d'accès" }).click();
      await expect(toast(page, "Clé d'accès enregistrée : PC Linux · Chrome")).toBeVisible({ timeout: 30_000 });
      await tile.getByRole('button', { name: 'Renommer PC Linux · Chrome' }).click();
      const rename = page.getByRole('dialog', { name: "Renommer la clé d'accès" });
      await rename.getByLabel('Nom').fill('Poste de test');
      await rename.getByRole('button', { name: 'Renommer' }).click();
      await expect(tile.getByText('Poste de test', { exact: true })).toBeVisible();
      await tile.getByRole('button', { name: 'Supprimer Poste de test' }).click();
      await page.getByRole('alertdialog', { name: 'Supprimer la clé « Poste de test » ?' }).getByRole('button', { name: 'Supprimer la clé' }).click();
      await expect(toast(page, "Clé d'accès supprimée : Poste de test")).toBeVisible();
      await expect(tile.getByText("Aucune clé d'accès", { exact: false })).toBeVisible();
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => undefined);
    }
  });
});

test.describe('Serveur et maintenance', () => {
  test('les sessions parallèles se règlent dans Serveur', async ({ page }) => {
    test.skip(isMobile(), 'formulaire identique');
    const before = (await readSettings()).maxConcurrentSessions;
    await openSettings(page, '?onglet=serveur');
    try {
      const field = page.getByRole('spinbutton', { name: 'Sessions parallèles' });
      await field.fill('99');
      await page.getByRole('region', { name: 'Réglages du serveur' }).getByRole('button', { name: 'Enregistrer' }).click();
      await expect(page.getByText('Nombre entier entre 1 et 16 attendu.')).toBeVisible();
      await field.fill(String(before === 8 ? 9 : 8));
      await page.getByRole('region', { name: 'Réglages du serveur' }).getByRole('button', { name: 'Enregistrer' }).click();
      await expect(toast(page, `Sessions parallèles : ${before === 8 ? 9 : 8}`)).toBeVisible();
      await expect.poll(async () => (await readSettings()).maxConcurrentSessions).toBe(before === 8 ? 9 : 8);
    } finally {
      await patchSettings(page, { maxConcurrentSessions: before });
    }
  });

  test('les worktrees inactifs se nettoient après confirmation (T8), jamais ceux à modifications', async ({ page, stack, runnerApi }) => {
    const project = stack.seeded.projects!.outils!;
    const suffix = randomUUID().slice(0, 6);
    const clean = await runnerApi('createWorktree', { params: { projectId: project.id }, body: { branch: `test/inactif-${suffix}` } });
    const old = new Date(Date.now() - 45 * 86_400_000);
    await database.update(worktrees).set({ createdAt: old, lastUsedAt: old }).where(eq(worktrees.id, clean.id));
    try {
      await openSettings(page);
      if (isMobile()) await page.getByRole('button', { name: /Nettoyer les worktrees inactifs/ }).click();
      else await page.getByRole('region', { name: 'Maintenance' }).getByRole('button', { name: 'Examiner…' }).click();
      const dialog = page.getByRole('alertdialog', { name: /Supprimer \d+ worktrees? inactifs? \?/ });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Un worktree avec des modifications non commitées est exclu d'office.")).toBeVisible();
      const row = dialog.getByRole('checkbox', { name: new RegExp(clean.name) });
      await expect(row).toBeChecked();
      // Keep only our worktree selected.
      for (const box of await dialog.getByRole('checkbox', { checked: true }).all()) {
        if (!(await box.evaluate((el) => (el as HTMLInputElement).id))?.includes(clean.id)) await box.uncheck();
      }
      await dialog.getByRole('button', { name: 'Supprimer 1 worktree' }).click();
      await expect(toast(page, `Worktree ${clean.name} supprimé`)).toBeVisible({ timeout: 60_000 });
      const [audit] = await database
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'maintenance.worktree_removed'), eq(auditLog.targetId, clean.id)));
      expect(audit!.summary).toContain('branche conservée');
      const { worktrees: list } = await runnerApi('listWorktrees', { params: { projectId: project.id } });
      expect(list.find((item) => item.id === clean.id && item.status === 'active')).toBeUndefined();
    } finally {
      await runnerApi('removeWorktree', { params: { worktreeId: clean.id }, query: { force: true, deleteBranch: true } }).catch(() => undefined);
    }
  });

  test('les journaux montrent les opérations Git et leur sortie', async ({ page }) => {
    await openSettings(page);
    if (isMobile()) await page.getByRole('button', { name: /^Journaux/ }).click();
    else await page.getByRole('region', { name: 'Maintenance' }).getByRole('button', { name: 'Consulter' }).click();
    const drawer = page.getByRole('dialog', { name: 'Journaux' });
    await expect(drawer.getByText(/Clonage/).first()).toBeVisible({ timeout: 30_000 });
    await drawer.getByRole('button', { name: 'Voir le journal' }).first().click();
    await expect(drawer.locator('pre').first()).toBeVisible();
    await drawer.getByRole('radio', { name: 'Sessions Claude' }).click();
    await expect(drawer.getByText(/Terminée|Interrompue/).first()).toBeVisible();
  });
});

test.describe('Préférences', () => {
  test('le thème change tout de suite et reste enregistré', async ({ page }) => {
    test.skip(isMobile(), 'liste du bureau');
    await openSettings(page, '?onglet=preferences');
    try {
      await page.getByRole('combobox', { name: 'Thème' }).click();
      await page.getByRole('option', { name: 'Sombre' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect.poll(async () => (await readSettings()).theme).toBe('dark');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.getByRole('combobox', { name: 'Thème' }).click();
      await page.getByRole('option', { name: 'Clair' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect.poll(async () => (await readSettings()).theme).toBe('light');
    } finally {
      await database.update(appSettings).set({ theme: 'light' }).where(eq(appSettings.id, 1));
    }
  });

  test('un appareil abonné apparaît et se retire', async ({ page }) => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const endpoint = `https://push.example.test/e2e/${randomUUID()}`;
    const created = await page.request.post('/api/push/subscription', {
      headers: { origin: E2E_BASE_URL },
      data: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }, deviceLabel: 'Téléphone de test' },
    });
    test.skip(created.status() === 409, 'VAPID non configuré sur la pile');
    expect(created.status()).toBe(201);
    await openSettings(page, '?onglet=preferences');
    const tile = page.getByRole('region', { name: 'Appareils notifiés' });
    await expect(tile.getByText('Téléphone de test', { exact: true })).toBeVisible();
    await expect(tile.getByRole('button', { name: 'Envoyer une notification de test' })).toBeEnabled();
    await tile.getByRole('button', { name: 'Retirer Téléphone de test' }).click();
    await expect(toast(page, 'Appareil retiré : Téléphone de test')).toBeVisible();
    await expect(tile.getByText('Téléphone de test', { exact: true })).toHaveCount(0);
  });
});
