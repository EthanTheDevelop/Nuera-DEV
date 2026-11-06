import type { Page } from '@playwright/test';
import { E2E_BASE_URL, expect, requireAccounts, test, type StackState } from './fixtures';

/**
 * Smoke test of the local test stack (apps/web/e2e/harness), desktop and mobile: signed-in shell,
 * runner reachable, GitHub source connected through the fake GitHub with the test repositories, and a
 * session status travelling runner → web relay (/api/stream/events) → browser. With two accounts
 * (@comptes): account B sees its own server, its own source and its own session statuses.
 */

interface GithubOverview {
  mode: string;
  status: string;
  app: { slug: string } | null;
  accounts: Array<{ login: string }>;
  repoCount: number | null;
  sources?: Array<{ id: string; status: string; app?: { slug: string } | null; accounts?: Array<{ login: string }>; repoCount?: number | null }>;
}

/** Repositories the GitHub source of account `key` reaches (its app on the fake GitHub). */
function reposOf(stack: StackState, key: 'a' | 'b'): string[] {
  const app = stack.accounts.find((account) => account.key === key)!.github.app;
  return stack.allRepos.filter((repo) => (repo.installations[app] ?? 0) > 0).map((repo) => repo.fullName).sort();
}
const isMobile = () => test.info().project.name === 'mobile';

async function openHome(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
  await page.waitForFunction(() => document.readyState === 'complete');
}

test('le shell connecté s\'affiche avec sa navigation', async ({ page, stack }) => {
  await openHome(page);
  const navigation = page.locator('[aria-label="Navigation principale"]').filter({ visible: true });
  await expect(navigation).toHaveCount(1);
  for (const label of ['Projets', 'Sessions']) await expect(navigation.getByRole('link', { name: new RegExp(label) }).first()).toBeVisible();
  // The owner of the stack is the signed-in user (desktop: user card of the sidebar).
  if (!isMobile()) await expect(page.getByRole('button', { name: `${stack.owner.name} · menu du compte` })).toBeVisible();
  // No horizontal page scroll at 390 px.
  if (isMobile()) expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('le runner de la pile répond : pas de T5 « ne répond pas »', async ({ page, runnerApi }) => {
  const health = await runnerApi('health');
  expect(health).toBeTruthy();
  await openHome(page);
  // The live stream has time to report the runner (system.metrics snapshot at connection).
  await page.waitForTimeout(3000);
  await expect(page.locator('#t5-title')).toHaveCount(0);
  await expect(page.getByText(/ne répond pas$/)).toHaveCount(0);
});

test('GitHub est connecté via le faux GitHub avec les dépôts de test', async ({ page, stack }) => {
  const overview = await page.request.get('/api/integrations');
  expect(overview.status()).toBe(200);
  const body = (await overview.json()) as { github: GithubOverview };
  expect(body.github.mode).toBe('app');
  expect(body.github.status).toBe('connected');
  // The owner's source (app `a` of the fake GitHub), whatever other source a spec added.
  const source = body.github.sources?.find((item) => item.app?.slug === stack.github.slug);
  if (body.github.sources) expect(source, 'source GitHub du propriétaire').toBeTruthy();
  else expect(body.github.app?.slug).toBe(stack.github.slug);
  expect((source?.accounts ?? body.github.accounts).map((account) => account.login).sort()).toEqual(stack.github.accounts.map((account) => account.login).sort());
  expect(source?.repoCount ?? body.github.repoCount).toBe(stack.repos.length);

  const repos = await page.request.get('/api/integrations/github/repos');
  expect(repos.status()).toBe(200);
  const list = (await repos.json()) as { repos: Array<{ fullName: string }> };
  expect(list.repos.map((repo) => repo.fullName).sort()).toEqual(expect.arrayContaining(reposOf(stack, 'a')));
  // Never a repository only another space's source reaches.
  expect(list.repos.map((repo) => repo.fullName)).not.toContain('hugo-test/carnet-chantier');
});

test('@comptes le second compte voit son serveur, sa source GitHub et ses propres statuts', async ({ stack, as }) => {
  requireAccounts(2);
  const b = await as('b');
  const serverB = stack.runners.find((runner) => runner.key === 'b')!;
  const serverA = stack.runners.find((runner) => runner.key === 'a')!;
  await b.page.goto('/');
  await expect(b.page).toHaveURL(/\/$/);
  await expect(b.page.getByRole('heading', { level: 1 })).toHaveText(`Bonjour ${stack.accounts.find((account) => account.key === 'b')!.name.split(' ')[0]}`);
  await expect(b.page.getByText(serverB.name, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  await expect(b.page.getByText(serverA.name, { exact: false })).toHaveCount(0);

  const repos = await b.page.request.get('/api/integrations/github/repos');
  expect(repos.status()).toBe(200);
  const names = ((await repos.json()) as { repos: Array<{ fullName: string }> }).repos.map((repo) => repo.fullName);
  expect(names).toEqual(expect.arrayContaining(reposOf(stack, 'b')));
  expect(names.filter((name) => name.startsWith('dev-test/'))).toEqual([]);

  // B's live stream carries the statuses of B's server, never A's (A's seeded sessions live on « VPS-3 »).
  await b.page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __b: string[] }).__b = seen;
    const source = new EventSource('/api/stream/events');
    source.addEventListener('message', (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as { type: string; data: { sessionId?: string } };
      if (message.type === 'session.status' && message.data.sessionId) seen.push(message.data.sessionId);
    });
    (window as unknown as { __bSource: EventSource }).__bSource = source;
  });
  await expect.poll(() => b.page.evaluate(() => (window as unknown as { __bSource: EventSource }).__bSource.readyState), { timeout: 60_000 }).toBe(1);
  const session = await b.cli.createSession({ project: 'carnet', title: 'Vérification du second serveur', branch: 'test/verification-b' });
  try {
    await b.cli.sendInstruction(session.id, 'scenario:essai Réponds en une phrase.');
    await b.cli.waitForTurn(session.id, 'scenario:essai Réponds en une phrase.');
    await expect.poll(() => b.page.evaluate((id) => (window as unknown as { __b: string[] }).__b.includes(id), session.id), { timeout: 60_000 }).toBe(true);
    const ownerIds = new Set(Object.values(stack.seeded.sessions ?? {}).map((item) => item.id));
    const seen = await b.page.evaluate(() => (window as unknown as { __b: string[] }).__b);
    expect(seen.filter((id) => ownerIds.has(id))).toEqual([]);
  } finally {
    await b.page.evaluate(() => (window as unknown as { __bSource?: EventSource }).__bSource?.close()).catch(() => undefined);
    await b.runnerApi('stopSession', { params: { sessionId: session.id }, body: { force: false } }).catch(() => undefined);
    if (session.worktreeId) await b.runnerApi('removeWorktree', { params: { worktreeId: session.worktreeId }, query: { force: true, deleteBranch: true } }).catch(() => undefined);
  }
});

test('le statut d\'une session parvient au navigateur par /api/stream/events', async ({ page, stack, cli, runnerApi, waitForSessionStatus }) => {
  test.skip(!stack.seeded.projects?.outils, 'projets absents (E2E_SEED=none)');
  await openHome(page);

  // The browser listens to the global stream exactly as the shell does (EventSource, same origin).
  await page.evaluate(() => {
    const seen: Array<{ sessionId: string; status: string }> = [];
    (window as unknown as { __smoke: typeof seen }).__smoke = seen;
    const source = new EventSource('/api/stream/events');
    // Unnamed SSE messages: `{ seq, type, at, data }` (@nuera/shared/events).
    source.addEventListener('message', (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as { type: string; data: { sessionId?: string; status?: string } };
      if (message.type === 'session.status' && message.data.sessionId && message.data.status) seen.push({ sessionId: message.data.sessionId, status: message.data.status });
    });
    (window as unknown as { __smokeSource: EventSource }).__smokeSource = source;
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __smokeSource: EventSource }).__smokeSource.readyState), { timeout: 60_000 }).toBe(1);

  // A short-lived session on « outils » (the seeded sessions of « devis » stay untouched).
  const session = await cli.createSession({ project: 'outils', title: 'Vérification de la pile', branch: 'test/verification-pile' });
  try {
    await cli.sendInstruction(session.id, 'scenario:essai Réponds en une phrase.');
    await waitForSessionStatus(session.id, 'waiting_input', { timeoutMs: 120_000 });
    await expect
      .poll(() => page.evaluate((id) => (window as unknown as { __smoke: Array<{ sessionId: string; status: string }> }).__smoke.filter((item) => item.sessionId === id).map((item) => item.status), session.id), { timeout: 60_000 })
      .toEqual(expect.arrayContaining(['running', 'waiting_input']));
  } finally {
    await page.evaluate(() => (window as unknown as { __smokeSource?: EventSource }).__smokeSource?.close()).catch(() => undefined);
    // Frees its slot of « Sessions parallèles » and its worktree.
    await runnerApi('stopSession', { params: { sessionId: session.id }, body: { force: false } }).catch(() => undefined);
    await waitForSessionStatus(session.id, ['stopped', 'finished', 'interrupted', 'failed'], { timeoutMs: 60_000 }).catch(() => undefined);
    if (session.worktreeId) {
      await runnerApi('removeWorktree', { params: { worktreeId: session.worktreeId }, query: { force: true, deleteBranch: true } }).catch(() => undefined);
    }
  }
  expect(E2E_BASE_URL).toContain('localhost');
});
