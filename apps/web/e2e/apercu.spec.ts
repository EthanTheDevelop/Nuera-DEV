import type { Frame, Page } from '@playwright/test';
import { E2E_BASE_URL, expect, hideNextDevIndicator, test } from './fixtures';

/**
 * « Aperçu » — the worktree's dev server, live, beside the Claude Code session (desktop panel and
 * main view, phone tab), served from the preview origin: the app runs on http://localhost:<port>,
 * the preview on http://127.0.0.1:<same port> (PREVIEW_HOST of the stack), two distinct origins.
 * The project is the seeded devis-express, whose `npm run dev` is a tiny node:http server that
 * prints its port.
 *
 *   node apps/web/e2e/harness/stack.mjs e2e --name apercu --web-port 3610 -- apercu.spec.ts
 */
test.describe.configure({ mode: 'default' });

const isMobile = () => test.info().project.name === 'mobile';
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const PREVIEW_ORIGIN = `http://127.0.0.1:${new URL(E2E_BASE_URL).port}`;
const created: string[] = [];

test.afterAll(async () => {
  const { stackRunnerApi } = await import('./fixtures');
  const api = await stackRunnerApi();
  for (const sessionId of created.splice(0)) {
    const session = await api('getSession', { params: { sessionId } }).catch(() => null);
    if (session?.live) await api('stopSession', { params: { sessionId }, body: { force: true } }).catch(() => undefined);
  }
});

function previewFrame(page: Page): Frame | undefined {
  return page.frames().find((frame) => frame.parentFrame() !== null && frame.url().startsWith(`${PREVIEW_ORIGIN}/`));
}

test('Aperçu · démarrer le serveur, voir le site, changer de page, recharger après Claude, arrêter', async ({ page, cli }) => {
  const session = await cli.createSession({ title: `Aperçu ${unique()}`, branch: `test/apercu-${unique()}`, permissionMode: 'acceptEdits' });
  created.push(session.id);
  const mobile = isMobile();
  await page.goto(`/workspace/${session.id}${mobile ? '' : '?panneau=apercu'}`);
  await expect(page.getByRole('log', { name: 'Fil de la session' })).toBeVisible({ timeout: 120_000 });
  await hideNextDevIndicator(page);
  if (mobile) {
    // M05: five tabs, all readable at 390 px (and nothing scrolls sideways).
    await page.getByRole('tab', { name: 'Aperçu' }).click();
    await expect(page).toHaveURL(/onglet=apercu/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  const region = page.getByRole('region', { name: 'Aperçu du site' });
  await expect(region.getByText('Serveur arrêté')).toBeVisible({ timeout: 60_000 });
  await expect(region.getByText(/le site s'affiche ici dès que son port apparaît dans la sortie/)).toBeVisible();

  await region.getByRole('button', { name: 'Démarrer le serveur' }).first().click();
  await expect(region.getByText(/^En ligne · port \d+$/)).toBeVisible({ timeout: 120_000 });
  const frame = page.frameLocator('iframe[title^="Aperçu du site"]');
  await expect(frame.getByRole('heading', { name: 'Devis Express' })).toBeVisible({ timeout: 60_000 });
  // The site runs on the preview origin, never on the application's; the handoff token is spent.
  await expect.poll(() => previewFrame(page)?.url()).toBe(`${PREVIEW_ORIGIN}/`);
  expect(page.url().startsWith(E2E_BASE_URL)).toBe(true);
  await expect(page.locator('iframe[title^="Aperçu du site"]')).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads');

  // Path field: Enter navigates the frame; the field follows the page.
  const field = region.getByRole('textbox', { name: 'Chemin de la page' });
  await expect(field).toHaveValue('/');
  await field.fill('devis?id=3');
  await field.press('Enter');
  await expect.poll(() => previewFrame(page)?.url()).toBe(`${PREVIEW_ORIGIN}/devis?id=3`);
  await expect(field).toHaveValue('/devis?id=3');

  if (!mobile) {
    await region.getByRole('radio', { name: 'Téléphone' }).click();
    await expect.poll(async () => (await page.locator('iframe[title^="Aperçu du site"]').boundingBox())?.width).toBe(390);
    await region.getByRole('radio', { name: 'Bureau' }).click();

    // « Agrandir »: the preview becomes the main view, on the same page; back to the conversation.
    await region.getByRole('button', { name: 'Agrandir' }).click();
    await expect(page).toHaveURL(/vue=apercu/);
    await expect(page.getByRole('region', { name: 'Session Claude Code' })).toHaveCount(0);
    await expect.poll(() => previewFrame(page)?.url(), { timeout: 30_000 }).toBe(`${PREVIEW_ORIGIN}/devis?id=3`);
    await expect(page.getByRole('region', { name: 'Aperçu du site' })).toHaveCount(1);
    await page.getByRole('region', { name: 'Aperçu du site' }).getByRole('button', { name: 'Revenir à la conversation' }).click();
    await expect(page).not.toHaveURL(/vue=apercu/);
    await expect(page.getByRole('region', { name: 'Session Claude Code' })).toBeVisible();
    await expect.poll(() => previewFrame(page)?.url(), { timeout: 30_000 }).toBe(`${PREVIEW_ORIGIN}/devis?id=3`);
  }

  // No hot reload through the preview: a file written by Claude reloads the page (option on by default).
  let reloads = 0;
  page.on('framenavigated', (navigated) => {
    if (navigated.parentFrame() && navigated.url().startsWith(`${PREVIEW_ORIGIN}/`)) reloads += 1;
  });
  const instruction = await cli.script(`apercu-${unique()}`, {
    description: "Écrit un fichier dans le worktree",
    steps: [{ write: { file: 'src/apercu.js', content: 'export const apercu = true;\n' } }, { final: 'Fichier écrit.' }],
  });
  await cli.sendInstruction(session.id, instruction);
  await expect.poll(() => reloads, { timeout: 90_000 }).toBeGreaterThan(0);
  await expect(frame.getByRole('heading', { name: 'Devis Express' })).toBeVisible();

  // « Recharger » reloads the page shown.
  const before = reloads;
  await region.getByRole('button', { name: 'Recharger' }).click();
  await expect.poll(() => reloads).toBeGreaterThan(before);

  if (mobile) {
    await region.getByRole('button', { name: "Actions de l'aperçu" }).click();
    await page.getByRole('menuitem', { name: 'Arrêter le serveur' }).click();
  } else {
    await region.getByRole('button', { name: 'Arrêter' }).click();
  }
  await expect(region.getByText('Serveur arrêté')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('iframe[title^="Aperçu du site"]')).toHaveCount(0);
});

test('Aperçu · deux hôtes étanches : rien de l\'application sur l\'hôte d\'aperçu, rien de l\'aperçu sur l\'application', async ({ page }) => {
  test.skip(isMobile(), 'requêtes HTTP seulement');
  const api = page.request;
  // Preview host without its cookie: the relay answers, never an application page or route.
  for (const path of ['/', '/projets', '/api/projects', '/connexion']) {
    const response = await api.get(`${PREVIEW_ORIGIN}${path}`, { maxRedirects: 0 });
    expect(response.status(), path).toBe(401);
    expect(await response.text(), path).toContain('Aperçu fermé');
    expect(response.headers()['content-security-policy'], path).toBe(`frame-ancestors ${E2E_BASE_URL}`);
  }
  const entry = await api.get(`${PREVIEW_ORIGIN}/__nuera/entree?jeton=faux`, { maxRedirects: 0 });
  expect(entry.status()).toBe(401);
  expect(await entry.text()).toContain("Lien d'aperçu expiré");

  // Application host: the relay routes do not exist; pages may frame the preview origin only.
  for (const path of ['/api/apercu/proxy', '/api/apercu/entree?jeton=faux']) {
    const response = await api.get(`${E2E_BASE_URL}${path}`, { maxRedirects: 0 });
    expect(response.status(), path).toBe(404);
  }
  const home = await api.get(`${E2E_BASE_URL}/`);
  expect(home.headers()['content-security-policy']).toContain(`frame-src ${PREVIEW_ORIGIN}`);

  // Handoff of an unknown run: the same 404 as any unknown run, nothing opened.
  const unknown = await api.post(`${E2E_BASE_URL}/api/previews`, { data: { runId: '00000000-0000-4000-8000-000000000000' }, headers: { origin: E2E_BASE_URL } });
  expect(unknown.status()).toBe(404);
  expect((await unknown.json()).error.message).toBe('Lancement introuvable.');
});
