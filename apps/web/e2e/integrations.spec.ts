import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { createDb } from '@nuera/db';
import { mcpServers, projectMcpServers } from '@nuera/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { startFakeCoolify, type FakeCoolify } from '../src/server/coolify/test/fake-coolify';
import { startFakeMcp } from '../src/server/mcp/test/fake-mcp';
import { E2E_BASE_URL, E2E_DATABASE_URL, E2E_STACK_DIR, expect, hideNextDevIndicator, test } from './fixtures';

/**
 * Lot INTEGRATIONS-UI — Intégrations (D07 / M07) and the MCP drawers (D1 connected / D2 to
 * reconnect) on a real stack: fake GitHub (connected app, 2 accounts, 5 repositories), the real
 * runner with the TEST-ONLY fake CLI (`claude mcp login` terminal), plus a fake Coolify and a fake
 * MCP server started by this file on 127.0.0.1 (no Internet).
 *
 *   E2E_STACK=intui pnpm --filter @nuera/web e2e integrations.spec.ts
 */
test.describe.configure({ mode: 'serial' });

const isMobile = () => test.info().project.name === 'mobile';
const SHOTS = path.join(E2E_STACK_DIR, 'shots');

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await hideNextDevIndicator(page);
  await page.waitForTimeout(500); // drawer / sheet entrance animation
  await page.screenshot({ path: path.join(SHOTS, `${name}-${isMobile() ? 'mobile' : 'bureau'}.png`) });
}

const toast = (page: Page, message: string) => page.getByText(message, { exact: true }).first();

async function openPage(page: Page, query = '') {
  await page.goto(`/integrations${query}`);
  await expect(page.getByRole('heading', { name: 'Intégrations', level: 1 })).toBeVisible({ timeout: 120_000 });
}

/** Opens a server's drawer (desktop) / sheet (phone) by a soft navigation from the page. */
async function openServer(page: Page, label: string) {
  if (isMobile()) {
    await page.getByRole('link', { name: label, exact: true }).click();
  } else {
    await page.getByRole('article', { name: label }).getByRole('link').click();
  }
  const dialog = page.getByRole('dialog', { name: label });
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  return dialog;
}

const db = createDb(E2E_DATABASE_URL);

/** Built-in servers back to « enabled in no project », status unknown (each test starts clean). */
async function resetPresets() {
  const rows = await db.select({ id: mcpServers.id }).from(mcpServers).where(inArray(mcpServers.name, ['figma', 'github', 'coolify', 'playwright']));
  if (rows.length) await db.delete(projectMcpServers).where(inArray(projectMcpServers.mcpServerId, rows.map((row) => row.id)));
  await db.update(mcpServers).set({ status: 'unknown' }).where(inArray(mcpServers.name, ['figma', 'github', 'coolify', 'playwright']));
}

const mutate = (page: Page, method: 'DELETE' | 'PUT' | 'POST', url: string, data?: unknown) =>
  page.request.fetch(url, { method, headers: { origin: E2E_BASE_URL }, ...(data === undefined ? {} : { data }) });

test.beforeEach(async () => {
  await resetPresets();
});

test.afterAll(async () => {
  await resetPresets();
  await db.delete(mcpServers).where(eq(mcpServers.name, 'essai-e2e'));
  await db.$client.end({ timeout: 5 });
});

test('D07 / M07 · GitHub, serveurs MCP et garde-fous viennent des vraies données', async ({ page, stack }) => {
  await openPage(page);
  const repoCount = stack.repos.length;
  if (isMobile()) {
    await expect(page.getByText('Les accès utilisés sur', { exact: false })).toBeVisible();
    await expect(page.getByText(`${repoCount} dépôts · contenu et pull requests en écriture`, { exact: false })).toBeVisible();
    for (const label of ['Figma', 'GitHub', 'Coolify', 'Playwright']) await expect(page.getByRole('link', { name: label, exact: true })).toBeVisible();
    await expect(page.getByText('Les actions de production Coolify ne passent jamais par Claude : elles restent dans Coolify.')).toBeVisible();
    // No horizontal scroll at 390 px.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } else {
    await expect(page.getByRole('heading', { name: 'GitHub · import et synchronisation des dépôts' })).toBeVisible();
    await expect(page.getByText(`${repoCount} dépôts`, { exact: true })).toBeVisible();
    for (const account of stack.github.accounts) await expect(page.getByText(account.login, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: "Gérer l'accès" })).toHaveAttribute('href', /installations\/new/);
    await expect(page.getByRole('heading', { name: 'Serveurs MCP · 4' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Production hors de portée' })).toBeVisible();
    await expect(page.getByText('Chaque connexion est vérifiée toutes les 15 minutes.', { exact: false })).toBeVisible();
    // « Voir les N dépôts »: grouped by account, read from the fake GitHub.
    await page.getByRole('button', { name: `Voir les ${repoCount} dépôts` }).click();
    const repos = page.getByRole('dialog', { name: 'Dépôts accessibles' });
    await expect(repos.getByText(stack.repos[0]!.fullName)).toBeVisible({ timeout: 30_000 });
    await repos.getByRole('button', { name: 'Fermer' }).click();
  }
  await shot(page, 'd07');
  // « Vérifier la connexion » → T3 toast.
  await page.getByRole('button', { name: isMobile() ? 'Vérifier' : 'Vérifier la connexion', exact: true }).click();
  await expect(toast(page, 'Connexion GitHub vérifiée')).toBeVisible({ timeout: 30_000 });
});

test('?github=<code> · toast de succès ou bandeau persistant', async ({ page }) => {
  await openPage(page, '?github=installed&compte=dev-test');
  await expect(toast(page, 'Application GitHub installée sur dev-test')).toBeVisible();
  await expect(page).toHaveURL(/\/integrations$/);
  await openPage(page, '?github=state_expired');
  const banner = page.getByRole('alert').filter({ hasText: 'Demande GitHub expirée' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Fermer' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page).toHaveURL(/\/integrations$/);
});

test('D1 · activer Figma dans un projet, tester, désactiver partout (T8)', async ({ page, stack }) => {
  const project = stack.seeded.projects!.devis!;
  await openPage(page);
  const drawer = await openServer(page, 'Figma');
  await expect(drawer.getByText('Serveur MCP · lecture des maquettes et des composants')).toBeVisible();
  await expect(drawer.getByText('Modifier les fichiers Figma')).toBeVisible();
  const toggle = drawer.getByRole('switch', { name: project.name });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await db.select().from(projectMcpServers).where(eq(projectMcpServers.projectId, project.id))).some((row) => row.enabled)).toBe(true);
  await shot(page, 'd1');
  // Journal toggle.
  await drawer.getByRole('button', { name: 'Voir le journal' }).click();
  await expect(drawer.getByRole('heading', { name: 'Journal' })).toBeVisible();
  // « Désactiver partout » asks first.
  await drawer.getByRole('button', { name: 'Désactiver partout' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Désactiver Figma partout ?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Désactiver partout' }).click();
  await expect(toast(page, 'Figma désactivé dans 1 projet')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  // Closing returns to the page, which re-reads its data.
  await drawer.getByRole('button', { name: 'Fermer' }).last().click();
  await expect(page).toHaveURL(/\/integrations$/);
  await expect(page.getByRole('dialog', { name: 'Figma' })).toHaveCount(0);
});

test('Page pleine · chargement direct de /integrations/mcp/figma', async ({ page }) => {
  await page.goto('/integrations/mcp/figma?journal=1');
  await expect(page.getByRole('heading', { name: 'Figma', level: 1 })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('heading', { name: 'Journal' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Intégrations' }).first()).toBeVisible();
  await page.goto('/integrations/mcp/inconnu');
  await expect(page.getByText('Serveur MCP introuvable')).toBeVisible({ timeout: 60_000 });
});

test("Ajouter un serveur MCP personnalisé, l'activer et tester la connexion", async ({ page, stack }) => {
  const fake = await startFakeMcp({ expectedAuthorization: 'Bearer jeton-e2e-0123456789', tools: ['search_docs', 'read_doc'], serverName: 'Docs' });
  try {
    await db.delete(mcpServers).where(eq(mcpServers.name, 'essai-e2e'));
    await openPage(page);
    await page.getByRole('button', { name: 'Ajouter un serveur MCP' }).last().click();
    const dialog = page.getByRole('dialog', { name: 'Ajouter un serveur MCP' });
    await dialog.getByLabel('Nom', { exact: true }).fill('Essai e2e');
    await expect(dialog.getByLabel('Identifiant')).toHaveValue('essai-e2e');
    await dialog.getByLabel('Adresse').fill(fake.url);
    await dialog.getByRole('combobox', { name: 'Authentification' }).click();
    await page.getByRole('option', { name: 'Jeton' }).click();
    const secret = dialog.getByLabel('Jeton', { exact: true });
    await expect(secret).toHaveValue('');
    await expect(secret).toHaveAttribute('type', 'password');
    await secret.fill('jeton-e2e-0123456789');
    await shot(page, 'ajout');
    await dialog.getByRole('button', { name: 'Ajouter le serveur' }).click();
    await expect(toast(page, 'Serveur MCP « Essai e2e » ajouté')).toBeVisible({ timeout: 30_000 });
    const drawer = page.getByRole('dialog', { name: 'Essai e2e' });
    await expect(drawer).toBeVisible({ timeout: 60_000 });
    await expect(drawer.getByText('en-têtes chiffrés · Authorization')).toBeVisible();
    // The secret never comes back.
    expect(await page.content()).not.toContain('jeton-e2e-0123456789');
    await drawer.getByRole('switch', { name: stack.seeded.projects!.outils!.name }).click();
    await drawer.getByRole('button', { name: 'Tester la connexion' }).click();
    await expect(toast(page, 'Connexion à Essai e2e vérifiée')).toBeVisible({ timeout: 30_000 });
    await expect(drawer.getByText('2 outils', { exact: false })).toBeVisible();
    // Delete it (T8, danger).
    await drawer.getByRole('button', { name: 'Supprimer' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Supprimer le serveur' }).click();
    await expect(toast(page, 'Serveur MCP « Essai e2e » supprimé')).toBeVisible();
    await expect(page).toHaveURL(/\/integrations$/);
    await expect(page.getByRole(isMobile() ? 'link' : 'article', { name: 'Essai e2e' })).toHaveCount(0);
  } finally {
    await fake.close();
  }
});

test.describe('Coolify · D2 « Reconnecter »', () => {
  let coolify: FakeCoolify;
  test.beforeAll(async () => {
    coolify = await startFakeCoolify();
    coolify.environments = [{ project: 'Nuera', uuid: 'p1', envs: ['development'] }];
    coolify.tokens.push(
      { value: '67|jeton-developpement-e2e', scoped: true, abilities: ['read', 'read:sensitive'] },
      { value: '68|jeton-production-e2e', scoped: false, abilities: ['read'] },
      { value: '69|jeton-renouvele-e2e', scoped: true, abilities: ['read', 'read:sensitive'] },
    );
  });
  test.afterAll(async () => {
    await coolify?.close();
  });

  test('premier jeton, refus production, expiration puis reconnexion', async ({ page }) => {
    await mutate(page, 'DELETE', '/api/integrations/coolify');
    await openPage(page);
    let drawer = await openServer(page, 'Coolify');
    await expect(drawer.getByText("Coolify n'est pas encore connecté")).toBeVisible();
    const reconnect = drawer.getByRole('button', { name: 'Reconnecter' });
    await expect(reconnect).toBeDisabled();
    await drawer.getByLabel('Adresse de Coolify').fill(coolify.url);
    // A token that also sees production is refused (422), nothing is stored.
    coolify.environments = [{ project: 'Nuera', uuid: 'p1', envs: ['development', 'production'] }];
    await drawer.getByLabel('Nouveau jeton Coolify').fill('68|jeton-production-e2e');
    await reconnect.click();
    await expect(drawer.getByText('Ce jeton voit aussi des environnements de production.')).toBeVisible({ timeout: 30_000 });
    coolify.environments = [{ project: 'Nuera', uuid: 'p1', envs: ['development'] }];
    await drawer.getByLabel('Nouveau jeton Coolify').fill('67|jeton-developpement-e2e');
    await reconnect.click();
    await expect(toast(page, 'Coolify connecté')).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/integrations$/);

    // Enable it in a project, then revoke the token in Coolify: the check marks it expired.
    drawer = await openServer(page, 'Coolify');
    await expect(drawer.getByText('jeton n°67', { exact: false })).toBeVisible();
    await drawer.getByRole('switch').first().click();
    await expect(drawer.getByRole('switch').first()).toHaveAttribute('aria-checked', 'true');
    await drawer.getByRole('button', { name: 'Fermer' }).last().click();
    coolify.tokens[0]!.revoked = true;
    const check = await mutate(page, 'POST', '/api/integrations/coolify/check');
    expect(check.status()).toBe(200);
    await openPage(page);
    const failing = isMobile() ? 'Coolify : autorisation expirée' : 'Coolify ne répond plus';
    const banner = page.getByRole('alert').filter({ hasText: failing });
    await expect(banner).toBeVisible();
    await expect(banner.getByText('Le jeton du serveur MCP a expiré.', { exact: false })).toBeVisible();
    await shot(page, 'd07-coolify');
    await banner.getByRole('link', { name: 'Reconnecter' }).click();
    drawer = page.getByRole('dialog', { name: 'Coolify' });
    await expect(drawer.getByText(/^Jeton expiré/)).toBeVisible({ timeout: 60_000 });
    await expect(drawer.getByText('Environnements de production')).toBeVisible();
    await shot(page, 'd2');
    await drawer.getByLabel('Nouveau jeton Coolify').fill('69|jeton-renouvele-e2e');
    await drawer.getByRole('button', { name: 'Reconnecter' }).click();
    await expect(toast(page, 'Coolify reconnecté')).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/integrations$/);
    await expect(page.getByRole('alert').filter({ hasText: failing })).toHaveCount(0, { timeout: 30_000 });
    expect(await page.content()).not.toContain('jeton-renouvele-e2e');
    await mutate(page, 'DELETE', '/api/integrations/coolify');
  });
});

test('Figma à reconnecter · terminal claude mcp login (faux CLI)', async ({ page, stack }) => {
  const enabled = await mutate(page, 'PUT', `/api/integrations/mcp/figma/projects/${stack.seeded.projects!.catalogue!.id}`, { enabled: true });
  expect(enabled.status()).toBe(200);
  await db.update(mcpServers).set({ status: 'expired' }).where(eq(mcpServers.name, 'figma'));
  await openPage(page);
  if (!isMobile()) await expect(page.getByRole('article', { name: 'Figma' }).getByText('Autorisation expirée')).toBeVisible();
  const drawer = await openServer(page, 'Figma');
  await expect(drawer.getByText(/^Autorisation expirée/).first()).toBeVisible();
  await drawer.getByRole('button', { name: 'Reconnecter', exact: true }).click();
  const terminal = page.getByRole('dialog', { name: 'Connexion MCP · Figma' });
  await expect(terminal).toBeVisible();
  await expect(terminal.locator('.xterm-rows')).toContainText('Paste the authorization code', { timeout: 90_000 });
  // The terminal dialog sits over the drawer: the drawer stays open underneath.
  await expect(page.getByRole('dialog', { name: 'Figma' })).toBeAttached();
  await shot(page, 'figma-terminal');
});
