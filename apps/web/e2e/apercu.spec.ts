import { mkdirSync, realpathSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Frame, Page } from '@playwright/test';
import { E2E_BASE_URL, E2E_STACK_DIR, expect, hideNextDevIndicator, test } from './fixtures';

/**
 * « Aperçu » — the worktree's dev server, live, beside the Claude Code session (desktop panel and
 * main view, phone tab), served from the preview origin: the app runs on http://localhost:<port>,
 * the preview on http://127.0.0.1:<same port> (PREVIEW_HOST of the stack), two distinct origins.
 * The project is the seeded devis-express, whose `npm run dev` is a tiny node:http server that
 * prints its port.
 *
 * A second case runs a REAL `next dev` (Next 16, app router, Turbopack) as the dev server of
 * catalogue-produits: the shapes of a framework (streamed HTML, `/_next/static/…`, RSC requests with
 * `_rsc`) through the whole chain (preview host → external rewrite → runner → dev server).
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

/** Minimal app router site (generated in the stack folder: never versioned), with the repo's own Next. */
function realNextApp(): string {
  const dir = nodePath.join(E2E_STACK_DIR, 'apercu-next');
  const webModules = fileURLToPath(new URL('../node_modules/', import.meta.url));
  mkdirSync(nodePath.join(dir, 'app', 'devis'), { recursive: true });
  mkdirSync(nodePath.join(dir, 'node_modules'), { recursive: true });
  for (const name of ['next', 'react', 'react-dom']) {
    const link = nodePath.join(dir, 'node_modules', name);
    if (!existsSync(link)) symlinkSync(realpathSync(nodePath.join(webModules, name)), link, 'junction');
  }
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'apercu-next', private: true, scripts: { dev: 'next dev' } }),
    // Turbopack resolves only inside its root: the repository (where `node_modules/.pnpm` lives).
    'next.config.mjs': `export default { agentRules: false, turbopack: { root: ${JSON.stringify(realpathSync(fileURLToPath(new URL('../../../', import.meta.url))))} } };\n`,
    'app/layout.jsx': 'export default function Layout({ children }) { return <html lang="fr"><body>{children}</body></html>; }\n',
    'app/page.jsx': "import Link from 'next/link';\nexport default function Page() { return <main><h1>Site Next réel</h1><Link href=\"/devis\">Devis</Link></main>; }\n",
    'app/devis/page.jsx': 'export default function Devis() { return <main><h1>Page devis</h1></main>; }\n',
  };
  for (const [file, content] of Object.entries(files)) writeFileSync(nodePath.join(dir, file), content);
  return dir;
}

test('Aperçu · un vrai next dev : page HTML servie telle quelle, requêtes RSC transmises sans boucle', async ({ page, cli, stack }) => {
  test.skip(isMobile(), 'même chaîne que sur ordinateur');
  test.setTimeout(240_000);
  const project = stack.seeded?.projects?.catalogue;
  test.skip(!project, 'projet catalogue absent (seed projects)');
  const dir = realNextApp();
  const next = nodePath.join(dir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const port = 3000 + (Number(new URL(E2E_BASE_URL).port) % 1000) + 50;
  const patch = (dev: string | null) => page.request.patch(`${E2E_BASE_URL}/api/projects/${project!.id}`, { data: { commands: { dev } }, headers: { origin: E2E_BASE_URL } });
  const before = await (await page.request.get(`${E2E_BASE_URL}/api/projects/${project!.id}`)).json().catch(() => null);
  expect((await patch(`cd "${dir}" && node "${next}" dev --port ${port}`)).status()).toBe(200);
  const session = await cli.createSession({ project: 'catalogue', title: `Aperçu Next ${unique()}`, branch: `test/apercu-next-${unique()}`, permissionMode: 'acceptEdits' });
  created.push(session.id);
  try {
    await page.goto(`/workspace/${session.id}?panneau=apercu`);
    await expect(page.getByRole('log', { name: 'Fil de la session' })).toBeVisible({ timeout: 120_000 });
    await hideNextDevIndicator(page);
    const region = page.getByRole('region', { name: 'Aperçu du site' });
    const documentResponse = page.waitForResponse((r) => r.url() === `${PREVIEW_ORIGIN}/` && r.request().resourceType() === 'document', { timeout: 180_000 });
    await region.getByRole('button', { name: 'Démarrer le serveur' }).first().click();
    await expect(region.getByText(new RegExp(`^En ligne · port ${port}$`))).toBeVisible({ timeout: 120_000 });
    const frame = page.frameLocator('iframe[title^="Aperçu du site"]');
    await expect(frame.getByRole('heading', { name: 'Site Next réel' })).toBeVisible({ timeout: 120_000 });

    // The page reaches the browser as the dev server wrote it: an HTML document, never a download,
    // and nothing of the hop (runner address, run id, relay marker).
    const response = await documentResponse;
    const headers = await response.allHeaders();
    expect(response.status()).toBe(200);
    expect(headers['content-type']).toBe('text/html; charset=utf-8');
    expect(headers['content-disposition']).toBeUndefined();
    expect(headers['x-nuera-preview']).toBeUndefined();
    expect(headers['x-middleware-rewrite']).toBe('/');
    expect(headers['content-security-policy']).toBe(`frame-ancestors ${E2E_BASE_URL}`);
    expect(Object.values(headers).join(' ')).not.toContain('/v1/runs/');
    // Position script added by the runner: the path field follows the page.
    await expect(region.getByRole('textbox', { name: 'Chemin de la page' })).toHaveValue('/');

    // An RSC request of the previewed site goes to ITS dev server (Nuera Dev's Next once answered it
    // itself, redirecting on `?_rsc=` forever and naming its own relay route).
    const preview = page.frames().find((f) => f.parentFrame() !== null && f.url().startsWith(`${PREVIEW_ORIGIN}/`))!;
    const rsc = await preview.evaluate(async () => {
      const r = await fetch('/devis', { headers: { RSC: '1' } });
      return { status: r.status, type: r.headers.get('content-type'), url: r.url, rewritten: r.headers.get('x-nextjs-rewritten-path'), body: (await r.text()).includes('Page devis') };
    });
    expect(rsc).toMatchObject({ status: 200, type: 'text/x-component', rewritten: null, body: true });
    expect(rsc.url).toMatch(new RegExp(`^${PREVIEW_ORIGIN}/devis\\?_rsc`));

    await region.getByRole('button', { name: 'Arrêter' }).click();
    await expect(region.getByText('Serveur arrêté')).toBeVisible({ timeout: 60_000 });
  } finally {
    await patch(before?.project?.commands?.dev ?? null).catch(() => undefined);
  }
});
