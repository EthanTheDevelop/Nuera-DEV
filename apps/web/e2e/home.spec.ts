import { request as playwrightRequest, type Locator, type Page } from '@playwright/test';
import { E2E_BASE_URL, expect, test } from './fixtures';

/**
 * Lot HOME — Accueil (D01 desktop / M01 phone) and the global search of the command palette, against
 * the stack's REAL runner (pty backend, TEST-ONLY fake CLI), fake GitHub and seeded data.
 *
 *   E2E_STACK=home pnpm --filter @nuera/web e2e home.spec.ts
 *
 * Sessions created here are stopped at the end (the seeds keep 3 CLIs alive).
 */
test.describe.configure({ mode: 'serial' });

const isMobile = () => test.info().project.name === 'mobile';

function visible(page: Page, selector: string): Locator {
  return page.locator(`${selector}:visible`);
}

async function openHome(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: /^Bonjour / })).toBeVisible({ timeout: 120_000 });
  await page.waitForFunction(() => document.readyState === 'complete');
}

test('Accueil : en-tête, serveur et Claude Code lus du runner et du CLI', async ({ page, stack }) => {
  await openHome(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Bonjour ${stack.owner.name.split(' ')[0]}`);
  if (isMobile()) {
    await expect(page.getByText(/^[A-Z][a-zé]+\. \d{1,2} [a-zéû]+\.? · tout est disponible$/)).toBeVisible();
    await expect(page.getByText('VPS-3 en ligne')).toBeVisible();
    await expect(page.getByText('Claude Code connecté', { exact: true }).filter({ visible: true })).toBeVisible();
    // No horizontal page scroll at 390 px (the rail scrolls inside itself).
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } else {
    await expect(page.getByText(/ · VPS-3 et Claude Code sont disponibles$/)).toBeVisible();
    const server = page.getByRole('region', { name: 'Serveur VPS-3' });
    await expect(server.getByText('En ligne', { exact: true })).toBeVisible();
    await expect(server.getByRole('meter')).toHaveCount(3);
    await expect(server.getByRole('meter', { name: 'Mémoire' })).toHaveAttribute('aria-valuetext', /^\d+(,\d)? \/ \d+(,\d)? Go$/);
    await expect(server).toContainText(/en ligne depuis \d+ (j|h|min)/);
    const claude = page.getByRole('region', { name: 'Claude Code' });
    await expect(claude.getByText('Attention requise')).toBeVisible();
    await expect(claude).toContainText(/\d+ ?sessions? actives? sur \d+ possibles?/);
    await expect(claude).toContainText('Nuera Dev ne stocke aucun identifiant.');
    await expect(claude).toContainText('modèle : défaut du CLI');
    await expect(claude.getByRole('link', { name: 'Voir les sessions' })).toHaveAttribute('href', '/sessions');
  }
});

test("Accueil : la demande d'autorisation mène à la session, sur la demande", async ({ page, stack }) => {
  const waiting = stack.seeded.sessions!.waitingPermission!;
  await openHome(page);
  if (isMobile()) {
    const card = page.getByRole('region', { name: 'Une session attend votre accord' });
    await expect(card).toContainText(`${waiting.title} · Devis Express`);
    await expect(card).toContainText('$ npm run test');
    await expect(card.getByRole('link', { name: 'Répondre' })).toHaveAttribute('href', `/workspace/${waiting.id}#demande-${waiting.permissionId}`);
  } else {
    const claude = page.getByRole('region', { name: 'Claude Code' });
    await expect(claude).toContainText(`${waiting.title} attend votre autorisation`);
    await expect(claude.getByRole('link', { name: 'Répondre' })).toHaveAttribute('href', `/workspace/${waiting.id}#demande-${waiting.permissionId}`);
  }
  const card = visible(page, `[data-session-card="${waiting.id}"]`);
  await expect(card).toContainText('Autorisation demandée');
  await expect(card).toContainText('Attend votre accord pour npm run test');
  await card.getByRole('link', { name: 'Répondre' }).click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${waiting.id}#demande-${waiting.permissionId}$`), { timeout: 120_000 });
});

test('Accueil : sessions actives, reprise rapide, projets récents, dernières modifications', async ({ page, stack }) => {
  const seeded = stack.seeded;
  await openHome(page);
  const running = visible(page, `[data-session-card="${seeded.sessions!.running!.id}"]`);
  await expect(running).toContainText('En cours');
  await expect(running.getByRole('link', { name: 'Ouvrir' })).toHaveAttribute('href', `/workspace/${seeded.sessions!.running!.id}`);

  const resume = page.getByRole('region', { name: /^Reprise rapide$/i });
  await expect(resume.getByRole('link', { name: 'Reprendre la session' })).toHaveAttribute('href', /^\/workspace\/[0-9a-f-]{36}$/);

  const projects = page.getByRole('region', { name: /^Projets récents$/i });
  for (const key of ['devis', 'catalogue', 'outils'] as const) {
    const project = seeded.projects![key]!;
    await expect(projects.getByRole('link', { name: project.name })).toHaveAttribute('href', `/projets/${project.id}`);
  }
  await expect(projects.getByText('À jour').first()).toBeVisible();

  const changes = page.getByRole('region', { name: /^Dernières modifications$/i });
  const sha = seeded.changes!.commitSha.slice(0, 7);
  await expect(changes).toContainText(sha);
  if (!isMobile()) {
    await expect(changes).toContainText('par Claude Code');
    await expect(changes.getByRole('link', { name: 'Ouvrir sur GitHub' })).toHaveAttribute('href', /\/commits\//);
    const integrations = page.getByRole('region', { name: 'Intégrations' });
    await expect(integrations.getByRole('link', { name: 'GitHub' }).first()).toHaveAttribute('href', '/integrations');
    await expect(integrations).toContainText(`${stack.repos.length} dépôts accessibles`);
    await expect(integrations.getByRole('link', { name: 'Gérer' })).toHaveAttribute('href', '/integrations');
  }
  await projects.getByRole('link', { name: seeded.projects!.catalogue!.name }).click();
  await expect(page).toHaveURL(new RegExp(`/projets/${seeded.projects!.catalogue!.id}$`), { timeout: 120_000 });
});

test('Accueil : une nouvelle session apparaît en direct, puis disparaît à son arrêt', async ({ page, cli, runnerApi, waitForSessionStatus }) => {
  await openHome(page);
  const count = async () => {
    const text = isMobile()
      ? await visible(page, '#accueil-actives').innerText()
      : await page.getByRole('region', { name: 'Claude Code' }).locator('p').first().innerText();
    return Number(/(\d+)/.exec(text)?.[1] ?? Number.NaN);
  };
  const before = await count();
  const session = await cli.createSession({ title: `Accueil en direct ${Date.now().toString(36)}`, branch: 'test/accueil-direct', start: true });
  try {
    await waitForSessionStatus(session.id, ['waiting_input', 'running', 'new']);
    await expect.poll(count, { timeout: 30_000 }).toBe(before + 1);
    if (isMobile()) await expect(visible(page, `[data-session-card="${session.id}"]`)).toContainText(session.title);
    await runnerApi('stopSession', { params: { sessionId: session.id }, body: { force: true } });
    await expect.poll(count, { timeout: 30_000 }).toBe(before);
    await expect(visible(page, `[data-session-card="${session.id}"]`)).toHaveCount(0);
  } finally {
    await runnerApi('stopSession', { params: { sessionId: session.id }, body: { force: true } }).catch(() => undefined);
  }
});

test('Accueil : étoile de favori des projets récents (bureau)', async ({ page, stack }) => {
  test.skip(isMobile(), "M01 n'a pas d'étoile");
  const catalogue = stack.seeded.projects!.catalogue!;
  await openHome(page);
  const projects = page.getByRole('region', { name: 'Projets récents' });
  const star = projects.getByRole('button', { name: new RegExp(catalogue.name) });
  const initial = await star.getAttribute('aria-pressed');
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${catalogue.id}`) && r.request().method() === 'PATCH');
  await star.click();
  expect((await saved).ok()).toBe(true);
  await expect(star).toHaveAttribute('aria-pressed', initial === 'true' ? 'false' : 'true');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Projets récents' }).getByRole('button', { name: new RegExp(catalogue.name) })).toHaveAttribute('aria-pressed', initial === 'true' ? 'false' : 'true');
  // Back to the seeded state.
  const restored = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${catalogue.id}`) && r.request().method() === 'PATCH');
  await page.getByRole('region', { name: 'Projets récents' }).getByRole('button', { name: new RegExp(catalogue.name) }).click();
  expect((await restored).ok()).toBe(true);
  await expect(page.getByRole('region', { name: 'Projets récents' }).getByRole('button', { name: new RegExp(catalogue.name) })).toHaveAttribute('aria-pressed', initial ?? 'false');
});

test('Accueil : « Nouvelle session » ouvre la fenêtre du lot Sessions (bureau)', async ({ page }) => {
  test.skip(isMobile(), 'M01 déplace « Nouvelle session » dans Sessions');
  await openHome(page);
  await page.getByRole('button', { name: 'Nouvelle session', exact: true }).filter({ visible: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Nouvelle session' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('Recherche globale : ⌘K / Ctrl K trouve projets et sessions partout', async ({ page, stack }) => {
  const seeded = stack.seeded;
  // The API: bounded, owner only, validated.
  const api = await page.request.get('/api/search?q=devis');
  expect(api.status()).toBe(200);
  const body = (await api.json()) as { projects: Array<{ id: string }>; sessions: Array<{ id: string }>; actions: unknown[] };
  expect(body.projects.map((p) => p.id)).toContain(seeded.projects!.devis!.id);
  expect((await page.request.get('/api/search?q=')).status()).toBe(422);
  const stranger = await playwrightRequest.newContext({ baseURL: E2E_BASE_URL, storageState: { cookies: [], origins: [] } });
  try {
    expect([401, 403]).toContain((await stranger.get('/api/search?q=devis')).status());
  } finally {
    await stranger.dispose();
  }

  test.skip(isMobile(), 'pas de recherche globale au téléphone (M01)');
  await page.goto('/sessions');
  await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toBeVisible({ timeout: 120_000 });
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Recherche' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill('catalogue');
  const option = palette.getByRole('option', { name: /Catalogue produits/ });
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
  await expect(page).toHaveURL(new RegExp(`/projets/${seeded.projects!.catalogue!.id}$`), { timeout: 120_000 });

  await page.keyboard.press('Control+k');
  await palette.getByRole('combobox').fill('parcours');
  const session = palette.getByRole('option', { name: new RegExp(seeded.sessions!.waitingPermission!.title) });
  await expect(session).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+k');
  await palette.getByRole('combobox').fill('ajouter un projet');
  await expect(palette.getByRole('option', { name: /Ajouter un projet/ })).toBeVisible({ timeout: 15_000 });
});
