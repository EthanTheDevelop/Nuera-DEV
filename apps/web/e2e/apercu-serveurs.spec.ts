import type { Page } from '@playwright/test';
import { E2E_BASE_URL, expect, hideNextDevIndicator, test } from './fixtures';

/**
 * « Aperçu » with several dev servers in one worktree (Nuera OS: client + admin): each named server
 * starts on its own port and is previewed on its own; a dev server that does not start is handed to
 * Claude in the session by itself (« Demander à Claude de corriger automatiquement », on by default),
 * once — the fake CLI receives the instruction and answers.
 *
 *   node apps/web/e2e/harness/stack.mjs e2e --name apercu2 --web-port 3700 -- apercu-serveurs.spec.ts
 */
test.describe.configure({ mode: 'default' });

const isMobile = () => test.info().project.name === 'mobile';
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const created: string[] = [];

test.afterAll(async () => {
  const { stackRunnerApi } = await import('./fixtures');
  const api = await stackRunnerApi();
  for (const sessionId of created.splice(0)) {
    const session = await api('getSession', { params: { sessionId } }).catch(() => null);
    if (session?.live) await api('stopSession', { params: { sessionId }, body: { force: true } }).catch(() => undefined);
  }
});

/** A second dev server of the same worktree: a page of its own on the PORT it is given. */
const ADMIN =
  "node -e \"require('node:http').createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end('<!doctype html><title>Admin</title><h1>Administration</h1>'); }).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('admin prêt sur http://localhost:' + process.env.PORT))\"";

async function stopDevRuns(page: Page, projectId: string): Promise<void> {
  const list = await page.request.get(`${E2E_BASE_URL}/api/runs?projectId=${projectId}&kind=dev&limit=30`);
  const { runs } = (await list.json().catch(() => ({ runs: [] }))) as { runs: Array<{ id: string; status: string }> };
  for (const run of runs.filter((r) => r.status === 'running')) {
    await page.request.delete(`${E2E_BASE_URL}/api/runs/${run.id}`, { headers: { origin: E2E_BASE_URL } }).catch(() => undefined);
  }
}

test('Aperçu · deux serveurs de développement nommés, chacun son port et son aperçu ; un serveur qui ne démarre pas part à Claude', async ({ page, cli, stack }) => {
  test.setTimeout(300_000);
  const mobile = isMobile();
  const project = stack.seeded?.projects?.devis;
  test.skip(!project, 'projet devis absent (seed projects)');
  const token = `module-${unique()}`;
  const BROKEN = `node -e "console.error('Error: Cannot find module ${token}'); process.exit(1)"`;
  const patch = (commands: Record<string, unknown>) =>
    page.request.patch(`${E2E_BASE_URL}/api/projects/${project!.id}`, { data: { commands }, headers: { origin: E2E_BASE_URL } });
  const before = await (await page.request.get(`${E2E_BASE_URL}/api/projects/${project!.id}`)).json().catch(() => null);
  const previousDev: string | null = before?.project?.commands?.dev ?? 'npm run dev';
  expect(
    (await patch({ dev: 'npm run dev', devName: 'client', devServers: [{ name: 'admin', command: ADMIN }, { name: 'casse', command: BROKEN }] })).status(),
  ).toBe(200);
  // The fake CLI answers the hand-over (its instruction carries the server's output, hence the token).
  await cli.script(`apercu-correction-${unique()}`, {
    description: 'Diagnostic du serveur de développement',
    match: [token],
    steps: [{ final: 'Cause trouvée : le module manquant est déclaré, relancez « casse ».' }],
  });
  const session = await cli.createSession({ title: `Aperçu serveurs ${unique()}`, branch: `test/apercu2-${unique()}`, permissionMode: 'acceptEdits' });
  created.push(session.id);
  try {
    await page.goto(`/workspace/${session.id}${mobile ? '' : '?panneau=apercu'}`);
    await expect(page.getByRole('log', { name: 'Fil de la session' })).toBeVisible({ timeout: 120_000 });
    await hideNextDevIndicator(page);
    if (mobile) await page.getByRole('tab', { name: 'Aperçu' }).click();
    const region = page.getByRole('region', { name: 'Aperçu du site' });
    await expect(region.getByText('Serveur « client » arrêté')).toBeVisible({ timeout: 120_000 });
    const frame = page.frameLocator('iframe[title^="Aperçu du site"]');

    /** Picks a dev server (desktop: its tab; phone: the compact menu of the toolbar). */
    const show = async (name: string) => {
      if (mobile) {
        await region.getByRole('button', { name: /^Serveur affiché : / }).click();
        await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).first().click();
      } else {
        await region.getByRole('tab', { name: new RegExp(`^${name}( · \\d+)?$`) }).click();
      }
    };
    /** « + Lancer… » (desktop) / the compact menu (phone): starts a dev server that does not run. */
    const launch = async (name: string) => {
      if (mobile) await region.getByRole('button', { name: /^Serveur affiché : / }).click();
      else await region.getByRole('button', { name: 'Lancer…' }).click();
      await page.getByRole('menuitem', { name: `Lancer « ${name} »` }).click();
    };
    const portOf = async (name: string) => {
      if (mobile) {
        const label = await region.getByRole('button', { name: new RegExp(`^Serveur affiché : ${name} · \\d+$`) }).getAttribute('aria-label');
        return Number(/(\d+)$/.exec(label ?? '')?.[1]);
      }
      const text = await region.getByRole('tab', { name: new RegExp(`^${name} · \\d+$`) }).textContent();
      return Number(/(\d+)$/.exec(text ?? '')?.[1]);
    };

    // client: the default server (`commands.dev`, named).
    if (mobile) {
      await region.getByRole('button', { name: "Actions de l'aperçu" }).click();
      await page.getByRole('menuitem', { name: 'Démarrer le serveur' }).click();
    } else {
      await region.getByRole('button', { name: 'Démarrer « client »' }).click();
    }
    await expect(region.getByText(/^En ligne · port \d+$/)).toBeVisible({ timeout: 120_000 });
    await expect(frame.getByRole('heading', { name: 'Devis Express' })).toBeVisible({ timeout: 60_000 });

    // admin beside it: its own port, its own page.
    await launch('admin');
    await expect(frame.getByRole('heading', { name: 'Administration' })).toBeVisible({ timeout: 120_000 });
    await expect(region.getByText(/^En ligne · port \d+$/)).toBeVisible();
    const adminPort = await portOf('admin');
    await show('client');
    await expect(frame.getByRole('heading', { name: 'Devis Express' })).toBeVisible({ timeout: 60_000 });
    const clientPort = await portOf('client');
    expect(clientPort).toBeGreaterThan(0);
    expect(adminPort).toBeGreaterThan(0);
    expect(clientPort).not.toBe(adminPort);
    await show('admin');
    await expect(frame.getByRole('heading', { name: 'Administration' })).toBeVisible({ timeout: 60_000 });
    if (mobile) expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // casse: exits at once with an error → handed to Claude in this session, by itself, once.
    await launch('casse');
    await expect(region.getByText(/^Erreur · code 1$/)).toBeVisible({ timeout: 120_000 });
    await expect(region.getByText(/Sortie du serveur envoyée à Claude dans cette session|Claude travaille encore/)).toBeVisible({ timeout: 60_000 });
    const { stackRunnerApi } = await import('./fixtures');
    const api = await stackRunnerApi();
    const lastInstruction = async () => (await api('getSession', { params: { sessionId: session.id } })).lastInstruction ?? '';
    await expect.poll(lastInstruction, { timeout: 120_000 }).toContain(token);
    const received = await lastInstruction();
    expect(received).toContain('Le serveur de développement « casse »');
    expect(received).toContain(`Cannot find module ${token}`);
    expect(received).toContain('Trouve la cause et corrige-la');
    // The fake CLI received it and answered in the thread.
    if (!mobile) await expect(page.getByRole('log', { name: 'Fil de la session' }).getByText(/Cause trouvée : le module manquant/)).toBeVisible({ timeout: 120_000 });

    // Never twice for the same run (audited once), even when asked by hand.
    const again = await page.request.post(`${E2E_BASE_URL}/api/previews/autodebug`, {
      data: { runId: (await (await page.request.get(`${E2E_BASE_URL}/api/runs?projectId=${project!.id}&kind=dev&limit=1`)).json()).runs[0].id, sessionId: session.id, trigger: 'manual' },
      headers: { origin: E2E_BASE_URL },
    });
    expect(again.status()).toBe(409);
    expect((await again.json()).error.reason).toBe('AUTODEBUG_ALREADY_SENT');
  } finally {
    await stopDevRuns(page, project!.id);
    await patch({ dev: previousDev, devName: null, devServers: null }).catch(() => undefined);
  }
});
