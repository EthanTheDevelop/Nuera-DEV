import { execFileSync } from 'node:child_process';
import type { APIRequestContext, Page } from '@playwright/test';
import { E2E_BASE_URL, expect, fakeGithubState, requireAccounts, restartComponent, stackRunnerApi, stopComponent, test, type AccountSession, type CliHelpers, type SessionDto, type StackState } from './fixtures';

/**
 * TRAVAIL SIMULTANÉ (MULTICOMPTE §1, §4, §13) — A (owner, desktop, server « VPS-3 ») and B (member,
 * phone context, server « VPS-4 ») work at the same moment, each on their own server:
 *   1. both send a scripted turn at the same instant: each Workspace streams only its own lines;
 *   2. each runner lists only its own session; each answers its own permission through the web;
 *   3. capacity is per server: B full, A still has room;
 *   4. both commit, push and open a pull request on the SAME repository (atelier-test/devis-express)
 *      with their own Git identity and their own GitHub source (app `a` / app `b` of the fake);
 *   5. restarting B's runner interrupts B's session only (reconcile scoped to its server), then B resumes;
 *   6. B's Claude login lost (T6) and B's server down (T5 for B) never show for A.
 *
 *   node apps/web/e2e/harness/stack.mjs e2e --name e2e -- simultane.spec.ts --project desktop
 */
test.describe.configure({ mode: 'serial' });
requireAccounts(2);
test.skip(({ isMobile }) => isMobile, 'B ouvre lui-même un contexte téléphone : projet « desktop »');

const origin = { origin: E2E_BASE_URL };
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const live = new Map<string, 'a' | 'b'>();

test.afterAll(async () => {
  test.setTimeout(5 * 60_000);
  // Runner B must be up again whatever happened.
  const { componentHealth, loadState } = await import('./harness/stack');
  const { E2E_STACK } = await import('./fixtures');
  if (!(await componentHealth(loadState(E2E_STACK), 'runner-b'))) await restartComponent('runner-b').catch(() => undefined);
  for (const [sessionId, key] of live) {
    const api = await stackRunnerApi(key);
    const session = await api('getSession', { params: { sessionId } }).catch(() => null);
    if (session?.live) await api('stopSession', { params: { sessionId }, body: { force: true } }).catch(() => undefined);
    if (session?.worktreeId) await api('removeWorktree', { params: { worktreeId: session.worktreeId }, query: { force: true, deleteBranch: true } }).catch(() => undefined);
  }
});

function git(cwd: string, ...args: string[]): string {
  // Same bytes as the runner (core.autocrlf=false): Git for Windows turns autocrlf on system-wide.
  return execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' }).trim();
}

function account(stack: StackState, key: 'a' | 'b') {
  return stack.accounts.find((item) => item.key === key)!;
}

async function scriptedTurn(cli: CliHelpers, name: string, say: string, file: string, final: string): Promise<string> {
  const instruction = await cli.script(name, {
    description: `Travail simultané (${name})`,
    steps: [{ say }, { wait: { command: `npm run verifier -- ${name}`, description: 'Vérification', seconds: 8, every: 1, output: [`${name} vérifié`] } }, { write: { file, content: `# ${name}\n` } }, { final }],
  });
  return `${instruction} Travaille sur ta note.`;
}

async function decide(request: APIRequestContext, permissionId: string): Promise<number> {
  const response = await request.post(`/api/permissions/${permissionId}/decision`, { data: { optionId: 'allow' }, headers: origin });
  return response.status();
}

async function openThread(page: Page, sessionId: string) {
  await page.goto(`/workspace/${sessionId}`);
  await expect(page.getByRole('log', { name: 'Fil de la session' }).or(page.getByRole('tablist', { name: 'Onglets du Workspace' })).first()).toBeVisible({ timeout: 120_000 });
}

let sessionA: SessionDto;
let sessionB: SessionDto;
let b: AccountSession;
const u = unique();
const files = { a: `docs/simultane-a-${u}.md`, b: `docs/simultane-b-${u}.md` };
const says = { a: `A travaille sur VPS-3 (${u}).`, b: `B travaille sur son serveur (${u}).` };

test('deux sessions en même temps, chacune sur son serveur, chacune son fil et ses autorisations', async ({ page, as, cli, stack }) => {
  test.setTimeout(10 * 60_000);
  b = await as('b', { mobile: true });
  [sessionA, sessionB] = await Promise.all([
    cli.createSession({ title: `Simultané A ${u}`, branch: `test/simultane-a-${u}` }),
    b.cli.createSession({ title: `Simultané B ${u}`, branch: `test/simultane-b-${u}` }),
  ]);
  live.set(sessionA.id, 'a');
  live.set(sessionB.id, 'b');
  const [turnA, turnB] = await Promise.all([
    scriptedTurn(cli, `simultane-a-${u}`, says.a, files.a, `Note ${files.a} prête.`),
    scriptedTurn(b.cli, `simultane-b-${u}`, says.b, files.b, `Note ${files.b} prête.`),
  ]);
  await openThread(page, sessionA.id);
  await openThread(b.page, sessionB.id);
  await Promise.all([cli.sendInstruction(sessionA.id, turnA), b.cli.sendInstruction(sessionB.id, turnB)]);

  // Each thread streams its own lines only.
  await expect(page.getByText(says.a)).toBeVisible({ timeout: 120_000 });
  await expect(b.page.getByText(says.b)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(says.b)).toHaveCount(0);
  await expect(b.page.getByText(says.a)).toHaveCount(0);

  // Each runner knows its own session only.
  const [listA, listB] = await Promise.all([(await stackRunnerApi('a'))('listSessions', undefined), (await stackRunnerApi('b'))('listSessions', undefined)]);
  const idsA = JSON.stringify(listA);
  const idsB = JSON.stringify(listB);
  expect(idsA).toContain(sessionA.id);
  expect(idsA).not.toContain(sessionB.id);
  expect(idsB).toContain(sessionB.id);
  expect(idsB).not.toContain(sessionA.id);

  // Each answers its own permission through the web; the other one's is unknown to them.
  const [permissionA, permissionB] = await Promise.all([cli.waitForPermission(sessionA.id, 180_000), b.cli.waitForPermission(sessionB.id, 180_000)]);
  expect(await decide(b.page.request, permissionA.id)).toBe(404);
  expect(await decide(page.request, permissionB.id)).toBe(404);
  expect(await decide(page.request, permissionA.id)).toBe(200);
  expect(await decide(b.page.request, permissionB.id)).toBe(200);
  const [doneA, doneB] = await Promise.all([cli.waitForTurn(sessionA.id, turnA), b.cli.waitForTurn(sessionB.id, turnB)]);
  sessionA = doneA;
  sessionB = doneB;
  expect(git(sessionA.worktree!.path, 'status', '--porcelain')).toBe(`?? ${files.a}`);
  expect(git(sessionB.worktree!.path, 'status', '--porcelain')).toBe(`?? ${files.b}`);
  // Two servers, two folders: B's worktree lives under B's projects root.
  const runnerB = stack.runners.find((runner) => runner.key === 'b')!;
  expect(sessionB.worktree!.path.replace(/\\/g, '/').toLowerCase()).toContain(runnerB.paths.projects.replace(/\\/g, '/').toLowerCase());
});

test('capacité par serveur : B complet, A garde de la place', async ({ page, as, stack }) => {
  test.skip(!sessionB, 'parcours précédent requis');
  // Each test gets its own browser contexts: B's phone context is opened again.
  b = await as('b', { mobile: true });
  const { createDb } = await import('@nuera/db');
  const { environments } = await import('@nuera/db/schema');
  const { eq } = await import('drizzle-orm');
  const { E2E_DATABASE_URL } = await import('./fixtures');
  const database = createDb(E2E_DATABASE_URL, { max: 1, applicationName: 'e2e-simultane' });
  const serverB = stack.runners.find((runner) => runner.key === 'b')!.environmentId!;
  const [row] = await database.select({ max: environments.maxConcurrentSessions }).from(environments).where(eq(environments.id, serverB));
  const { capacity } = await (await stackRunnerApi('b'))('listSessions', undefined);
  await database.update(environments).set({ maxConcurrentSessions: Math.max(1, capacity.live) }).where(eq(environments.id, serverB));
  try {
    await expect(async () => {
      const refused = await b.page.request.post('/api/sessions', { data: { projectId: account(stack, 'b').seeded!.projects!.devis!.id, branch: { mode: 'new', branch: `test/plein-${u}` } }, headers: origin });
      expect(refused.status()).toBe(409);
    }).toPass({ timeout: 30_000 });
    const capacityA = (await (await stackRunnerApi('a'))('listSessions', undefined)).capacity;
    expect(capacityA.live).toBeLessThan(capacityA.max);
  } finally {
    await database.update(environments).set({ maxConcurrentSessions: row!.max }).where(eq(environments.id, serverB));
    await database.$client.end({ timeout: 5 });
  }
  void page;
});

test("commits, push et pull requests sur le même dépôt : l'identité et la source GitHub de chacun", async ({ page, as, stack }) => {
  test.skip(!sessionB, 'parcours précédent requis');
  // Each test gets its own browser contexts: B's phone context is opened again.
  b = await as('b', { mobile: true });
  test.setTimeout(5 * 60_000);
  const results: Record<'a' | 'b', { number: number }> = { a: { number: 0 }, b: { number: 0 } };
  for (const [key, request, session, file] of [
    ['a', page.request, sessionA, files.a],
    ['b', b.page.request, sessionB, files.b],
  ] as const) {
    const worktreeId = session.worktree!.id;
    const commit = await request.post(`/api/worktrees/${worktreeId}/commit`, { data: { message: `docs: note simultanée ${key}`, paths: [file], sessionId: session.id }, headers: origin });
    expect(commit.status(), await commit.text()).toBeLessThan(300);
    const identity = account(stack, key).gitIdentity;
    expect(git(session.worktree!.path, 'log', '-1', '--format=%an|%ae')).toBe(`${identity.name}|${identity.email}`);
    const push = await request.post(`/api/worktrees/${worktreeId}/push`, { data: { sessionId: session.id }, headers: origin });
    expect(push.status(), await push.text()).toBeLessThan(300);
    const pull = await request.post(`/api/worktrees/${worktreeId}/pull-request`, { data: { title: `Note simultanée ${key} ${u}`, sessionId: session.id }, headers: origin });
    expect(pull.status(), await pull.text()).toBeLessThan(300);
    const body = (await pull.json()) as { number?: number; pullRequest?: { number?: number } };
    results[key].number = body.number ?? body.pullRequest?.number ?? 0;
  }
  const fake = await fakeGithubState();
  const pullA = fake.pulls.find((item) => item.repo === 'devis-express' && item.head === sessionA.worktree!.branch);
  const pullB = fake.pulls.find((item) => item.repo === 'devis-express' && item.head === sessionB.worktree!.branch);
  expect(pullA?.app).toBe(account(stack, 'a').github.app);
  expect(pullB?.app).toBe(account(stack, 'b').github.app);
  expect(pullA!.number).not.toBe(pullB!.number);
  if (results.a.number && results.b.number) expect([results.a.number, results.b.number].sort()).toEqual([pullA!.number, pullB!.number].sort());
});

test('redémarrer le runner de B interrompt la session de B seulement, puis B la reprend', async ({ as, stack }) => {
  test.skip(!sessionB, 'parcours précédent requis');
  b = await as('b', { mobile: true });
  test.setTimeout(6 * 60_000);
  const apiA = await stackRunnerApi('a');
  const beforeA = await apiA('getSession', { params: { sessionId: sessionA.id } });
  expect(beforeA.live).toBe(true);
  await restartComponent('runner-b');
  const apiB = await stackRunnerApi('b');
  await expect.poll(async () => (await apiB('getSession', { params: { sessionId: sessionB.id } })).status, { timeout: 120_000 }).toBe('interrupted');
  const afterA = await apiA('getSession', { params: { sessionId: sessionA.id } });
  expect(afterA).toMatchObject({ live: true, status: beforeA.status });
  // A's seeded live sessions are untouched too.
  for (const seeded of [stack.seeded.sessions?.running, stack.seeded.sessions?.waitingPermission].filter(Boolean)) {
    const current = await apiA('getSession', { params: { sessionId: seeded!.id } }).catch(() => null);
    if (current) expect(current.status).not.toBe('interrupted');
  }
  await openThread(b.page, sessionB.id);
  await expect(b.page.getByText('Interrompue', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  const resumed = await b.page.request.post(`/api/sessions/${sessionB.id}/resume`, { headers: origin });
  expect(resumed.status(), await resumed.text()).toBeLessThan(300);
  await expect.poll(async () => (await apiB('getSession', { params: { sessionId: sessionB.id } })).live, { timeout: 120_000 }).toBe(true);
});

test('la connexion Claude perdue (T6) et le serveur arrêté (T5) de B ne touchent jamais A', async ({ page, as, stack }) => {
  test.skip(!sessionB, 'parcours précédent requis');
  // Each test gets its own browser contexts: B's phone context is opened again.
  b = await as('b', { mobile: true });
  test.setTimeout(6 * 60_000);
  const serverB = stack.runners.find((runner) => runner.key === 'b')!;
  await b.cli.setLoggedIn(false);
  try {
    await b.page.goto('/');
    await expect(b.page.getByRole('link', { name: 'Se reconnecter dans un terminal' }).first()).toBeVisible({ timeout: 60_000 });
    await page.goto('/');
    await page.waitForTimeout(3_000);
    await expect(page.getByRole('link', { name: 'Se reconnecter dans un terminal' })).toHaveCount(0);
  } finally {
    await b.cli.setLoggedIn(true);
  }

  await stopComponent('runner-b');
  try {
    await b.page.goto('/');
    await expect(b.page.getByText(`${serverB.name} ne répond pas`, { exact: false }).first()).toBeVisible({ timeout: 90_000 });
    await page.goto('/');
    await page.waitForTimeout(5_000);
    await expect(page.getByText(/ne répond pas/)).toHaveCount(0);
    await expect(page.locator('#t5-title')).toHaveCount(0);
  } finally {
    await restartComponent('runner-b');
  }
});
