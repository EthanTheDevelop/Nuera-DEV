import { randomUUID } from 'node:crypto';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { createDb } from '@nuera/db';
import { auditLog, commandRuns, githubSources, mcpServers, notifications, permissionRequests, projectEnvVars, projects, sessions, worktrees } from '@nuera/db/schema';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { RunnerApiError } from './harness/runner-api';
import { E2E_BASE_URL, E2E_DATABASE_URL, expect, requireAccounts, test, type SeededData, type StackState } from './fixtures';

/**
 * CLOISONNEMENT (MULTICOMPTE §1 invariant 1, §13) — account B (member, server « VPS-4 ») against the
 * data of account A (owner, server « VPS-3 »), and A against B's: every route that takes an
 * identifier (projects, worktrees, sessions, permissions, runs, terminals, streams, GitHub sources,
 * MCP servers) answers EXACTLY like for an unknown identifier (404, same body), lists never mix
 * spaces, B's live stream stays silent while A works and never replays from a Last-Event-ID of A's
 * server, B's server token cannot reach A's resources through the internal routes, B's runner does
 * not know A's ids. Nothing of A changes and no business audit row of B lands in A's space.
 *
 *   node apps/web/e2e/harness/stack.mjs e2e --name e2e -- isolation.spec.ts --project desktop
 *
 * Runs in « desktop » only (@comptes) and skips on a single-account stack.
 */
requireAccounts(2);
test.skip(({ isMobile }) => isMobile, 'contextes des deux comptes ouverts par le test : projet « desktop »');

const database = createDb(E2E_DATABASE_URL, { max: 2, applicationName: 'e2e-isolation' });
test.afterAll(async () => {
  await database.$client.end({ timeout: 5 });
});

const origin = { origin: E2E_BASE_URL };

interface ForeignIds {
  project: string;
  worktree: string;
  session: string;
  permission: string;
  run: string;
  operation: string;
  terminal: string;
  envVar: string;
  /** GitHub source of the space (`github_sources.id`). */
  source: string;
  /** MCP server of the space's registry, by its row id (the routes accept an id or a name). */
  mcp: string;
}

interface Probe {
  label: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: (ids: ForeignIds) => string;
  body?: (ids: ForeignIds) => unknown;
  /** Status expected for both ids when it is not 404 (an idempotent route documented as such). */
  status?: number;
}

/** Every route of the web that takes a resource identifier (MULTICOMPTE §5, inventory of the web lots). */
const PROBES: Probe[] = [
  // Projects
  { label: 'projet · lecture', method: 'GET', path: (i) => `/api/projects/${i.project}` },
  { label: 'projet · favori', method: 'PATCH', path: (i) => `/api/projects/${i.project}`, body: () => ({ favorite: true }) },
  { label: 'projet · archivage', method: 'DELETE', path: (i) => `/api/projects/${i.project}`, body: () => ({ removeClone: false }) },
  { label: 'projet · archivé ?', method: 'GET', path: (i) => `/api/projects/${i.project}/archive` },
  { label: 'projet · restauration', method: 'POST', path: (i) => `/api/projects/${i.project}/restore` },
  { label: 'projet · synchronisation', method: 'POST', path: (i) => `/api/projects/${i.project}/sync` },
  { label: 'projet · branches', method: 'GET', path: (i) => `/api/projects/${i.project}/branches` },
  { label: 'projet · nouvelle branche', method: 'POST', path: (i) => `/api/projects/${i.project}/branches`, body: () => ({ name: 'isolation/essai' }) },
  { label: 'projet · checkout', method: 'POST', path: (i) => `/api/projects/${i.project}/checkout`, body: () => ({ branch: 'main' }) },
  { label: 'projet · CLAUDE.md', method: 'GET', path: (i) => `/api/projects/${i.project}/claude-md` },
  { label: 'projet · écriture CLAUDE.md', method: 'PUT', path: (i) => `/api/projects/${i.project}/claude-md`, body: () => ({ content: '# Intrus\n', commit: false }) },
  { label: 'projet · nouveau clonage', method: 'POST', path: (i) => `/api/projects/${i.project}/clone`, body: () => ({}) },
  { label: 'projet · variables', method: 'GET', path: (i) => `/api/projects/${i.project}/env` },
  { label: 'projet · ajout de variable', method: 'POST', path: (i) => `/api/projects/${i.project}/env`, body: () => ({ key: 'INTRUS', value: 'x', secret: false }) },
  { label: 'projet · variable modifiée', method: 'PATCH', path: (i) => `/api/projects/${i.project}/env`, body: (i) => ({ id: i.envVar, value: 'x' }) },
  { label: 'projet · variable supprimée', method: 'DELETE', path: (i) => `/api/projects/${i.project}/env`, body: (i) => ({ id: i.envVar }) },
  { label: 'projet · MCP du projet', method: 'PUT', path: (i) => `/api/projects/${i.project}/mcp/figma`, body: () => ({ enabled: true }) },
  { label: 'projet · worktrees', method: 'GET', path: (i) => `/api/projects/${i.project}/worktrees` },
  { label: 'projet · worktree', method: 'GET', path: (i) => `/api/projects/${i.project}/worktrees/${i.worktree}` },
  { label: 'projet · suppression de worktree', method: 'DELETE', path: (i) => `/api/projects/${i.project}/worktrees/${i.worktree}?force=1` },
  { label: 'intégrations · MCP par projet', method: 'PUT', path: (i) => `/api/integrations/mcp/figma/projects/${i.project}`, body: () => ({ enabled: true }) },
  // Sessions
  { label: 'session · lecture', method: 'GET', path: (i) => `/api/sessions/${i.session}` },
  { label: 'session · renommage', method: 'PATCH', path: (i) => `/api/sessions/${i.session}`, body: () => ({ title: 'Intrus' }) },
  { label: 'session · suppression', method: 'DELETE', path: (i) => `/api/sessions/${i.session}` },
  { label: 'session · événements', method: 'GET', path: (i) => `/api/sessions/${i.session}/events` },
  { label: 'session · terminal', method: 'GET', path: (i) => `/api/sessions/${i.session}/terminal` },
  { label: 'session · archivage', method: 'POST', path: (i) => `/api/sessions/${i.session}/archive` },
  { label: 'session · instruction', method: 'POST', path: (i) => `/api/sessions/${i.session}/instruction`, body: () => ({ text: 'Intrus' }) },
  { label: 'session · interruption', method: 'POST', path: (i) => `/api/sessions/${i.session}/interrupt` },
  { label: 'session · reprise', method: 'POST', path: (i) => `/api/sessions/${i.session}/resume` },
  { label: 'session · arrêt', method: 'POST', path: (i) => `/api/sessions/${i.session}/stop`, body: () => ({ force: true }) },
  { label: 'session · création sur un projet', method: 'POST', path: () => '/api/sessions', body: (i) => ({ projectId: i.project, branch: { mode: 'new', branch: 'isolation/intrus' } }) },
  // Permissions and runs
  { label: 'autorisation · décision', method: 'POST', path: (i) => `/api/permissions/${i.permission}/decision`, body: () => ({ optionId: 'allow' }) },
  { label: 'lancement · lecture', method: 'GET', path: (i) => `/api/runs/${i.run}` },
  { label: 'lancement · arrêt', method: 'DELETE', path: (i) => `/api/runs/${i.run}` },
  { label: 'lancement · création', method: 'POST', path: () => '/api/runs', body: (i) => ({ projectId: i.project, kind: 'test' }) },
  { label: 'lancements · liste du projet', method: 'GET', path: (i) => `/api/runs?projectId=${i.project}` },
  // Worktrees (Diff / Git panels)
  { label: 'worktree · modifications', method: 'GET', path: (i) => `/api/worktrees/${i.worktree}/changes` },
  { label: 'worktree · diff', method: 'GET', path: (i) => `/api/worktrees/${i.worktree}/diff?path=README.md` },
  { label: 'worktree · fichier', method: 'GET', path: (i) => `/api/worktrees/${i.worktree}/file?path=README.md` },
  { label: 'worktree · état', method: 'GET', path: (i) => `/api/worktrees/${i.worktree}/status` },
  { label: 'worktree · arborescence', method: 'GET', path: (i) => `/api/worktrees/${i.worktree}/tree` },
  { label: 'worktree · indexation', method: 'POST', path: (i) => `/api/worktrees/${i.worktree}/stage`, body: () => ({ paths: ['README.md'] }) },
  { label: 'worktree · désindexation', method: 'POST', path: (i) => `/api/worktrees/${i.worktree}/unstage`, body: () => ({ paths: ['README.md'] }) },
  { label: 'worktree · commit', method: 'POST', path: (i) => `/api/worktrees/${i.worktree}/commit`, body: () => ({ message: 'intrus', paths: ['README.md'] }) },
  { label: 'worktree · push', method: 'POST', path: (i) => `/api/worktrees/${i.worktree}/push`, body: () => ({}) },
  { label: 'worktree · pull request', method: 'POST', path: (i) => `/api/worktrees/${i.worktree}/pull-request`, body: () => ({ title: 'Intrus' }) },
  // Terminals
  { label: 'terminal · shell dans un worktree', method: 'POST', path: () => '/api/terminals', body: (i) => ({ kind: 'shell', worktreeId: i.worktree }) },
  { label: 'terminal · lecture', method: 'GET', path: (i) => `/api/terminals/${i.terminal}` },
  { label: 'terminal · saisie', method: 'POST', path: (i) => `/api/terminals/${i.terminal}/input`, body: () => ({ data: 'echo intrus\r' }) },
  { label: 'terminal · taille', method: 'POST', path: (i) => `/api/terminals/${i.terminal}/resize`, body: () => ({ cols: 100, rows: 30 }) },
  // Idempotent close (contract unchanged): 204 for a closed, unknown or foreign terminal, nothing touched.
  { label: 'terminal · fermeture', method: 'DELETE', path: (i) => `/api/terminals/${i.terminal}`, status: 204 },
  // GitHub sources (MULTICOMPTE §7) and the space's MCP registry, by row id
  { label: 'source GitHub · lecture', method: 'GET', path: (i) => `/api/integrations/github/sources/${i.source}` },
  { label: 'source GitHub · renommage', method: 'PATCH', path: (i) => `/api/integrations/github/sources/${i.source}`, body: () => ({ label: 'Intrus' }) },
  { label: 'source GitHub · vérification', method: 'POST', path: (i) => `/api/integrations/github/sources/${i.source}/check` },
  { label: 'source GitHub · déconnexion', method: 'DELETE', path: (i) => `/api/integrations/github/sources/${i.source}` },
  { label: 'MCP · lecture', method: 'GET', path: (i) => `/api/integrations/mcp/${i.mcp}` },
  { label: 'MCP · modification', method: 'PATCH', path: (i) => `/api/integrations/mcp/${i.mcp}`, body: () => ({ label: 'Intrus' }) },
  { label: 'MCP · test de connexion', method: 'POST', path: (i) => `/api/integrations/mcp/${i.mcp}/check` },
  { label: 'MCP · désactivation partout', method: 'POST', path: (i) => `/api/integrations/mcp/${i.mcp}/disable-all` },
  { label: 'MCP · connexion (terminal)', method: 'POST', path: (i) => `/api/integrations/mcp/${i.mcp}/login` },
  { label: 'MCP · suppression', method: 'DELETE', path: (i) => `/api/integrations/mcp/${i.mcp}` },
  // Live streams (a leak would answer 200 and stream)
  { label: 'flux · session', method: 'GET', path: (i) => `/api/stream/sessions/${i.session}` },
  { label: 'flux · opération', method: 'GET', path: (i) => `/api/stream/operations/${i.operation}` },
  { label: 'flux · lancement', method: 'GET', path: (i) => `/api/stream/runs/${i.run}` },
  { label: 'flux · terminal', method: 'GET', path: (i) => `/api/stream/terminals/${i.terminal}` },
];

function unknownIds(ids: ForeignIds): ForeignIds {
  const terminal = Array.from({ length: ids.terminal.length }, (_, index) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(index * 7 + Date.now()) % 36]).join('');
  return { project: randomUUID(), worktree: randomUUID(), session: randomUUID(), permission: randomUUID(), run: randomUUID(), operation: randomUUID(), terminal, envVar: randomUUID(), source: randomUUID(), mcp: randomUUID() };
}

async function call(request: APIRequestContext, probe: Probe, ids: ForeignIds): Promise<APIResponse> {
  const body = probe.body?.(ids);
  return request.fetch(probe.path(ids), {
    method: probe.method,
    headers: { ...origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { data: body }),
    // A stream that answers would never end: a short timeout turns a leak into a failure.
    timeout: 60_000,
    maxRedirects: 0,
  });
}

interface Answer {
  status: number;
  code: string | null;
  message: string | null;
  /** Whole body, identifiers of the request replaced by a placeholder (an unknown id must not differ by more). */
  body: string;
}

async function answerOf(response: APIResponse, ids: ForeignIds): Promise<Answer> {
  let text = await response.text().catch(() => '');
  for (const id of Object.values(ids)) text = text.split(id).join('<id>');
  const parse = (): { error?: { code?: string; message?: string } } | null => {
    try {
      return JSON.parse(text) as { error?: { code?: string; message?: string } };
    } catch {
      return null;
    }
  };
  const body = parse();
  return { status: response.status(), code: body?.error?.code ?? null, message: body?.error?.message ?? null, body: text };
}

/**
 * Same request with a foreign id and with an unknown id: the same answer, byte for byte (ids aside).
 * A mutation, a stream or a single resource must be a 404; a read that lists by a parent id may answer
 * the same empty 200 for both (nothing told about the other space either way).
 */
async function expectSameAsUnknown(request: APIRequestContext, probes: Probe[], foreign: ForeignIds): Promise<string[]> {
  const unknown = unknownIds(foreign);
  const problems: string[] = [];
  for (const probe of probes) {
    const theirs = await answerOf(await call(request, probe, foreign), foreign);
    const nobody = await answerOf(await call(request, probe, unknown), unknown);
    const where = `${probe.label} (${probe.method} ${probe.path(foreign)})`;
    if (theirs.status !== nobody.status || theirs.body !== nobody.body) problems.push(`${where} : HTTP ${theirs.status} « ${theirs.message ?? theirs.body.slice(0, 120)} » (étranger) ≠ HTTP ${nobody.status} « ${nobody.message ?? nobody.body.slice(0, 120)} » (inconnu)`);
    const emptyRead = probe.method === 'GET' && theirs.status === 200 && probe.path(foreign).includes('?');
    const expected = probe.status ?? 404;
    if (theirs.status !== expected && !emptyRead) problems.push(`${where} : HTTP ${theirs.status} au lieu de ${expected} (${theirs.message ?? 'sans message'})`);
  }
  return problems;
}

function seededOf(stack: StackState, key: 'a' | 'b'): SeededData {
  return key === 'a' ? stack.seeded : (stack.accounts.find((account) => account.key === key)?.seeded ?? {});
}

/** Live resources of an account used as targets (a terminal and an env var are opened for the test). */
async function resourcesOf(stack: StackState, key: 'a' | 'b', request: APIRequestContext): Promise<ForeignIds> {
  const seeded = seededOf(stack, key);
  const devis = seeded.projects?.devis;
  const session = seeded.sessions?.running;
  expect(devis, `projets du compte ${key} absents : seed projects`).toBeTruthy();
  expect(session, `session « en cours » du compte ${key} absente : seed sessions`).toBeTruthy();
  const spaceId = stack.accounts.find((item) => item.key === key)!.spaceId!;
  const [pending] = await database
    .select({ id: permissionRequests.id })
    .from(permissionRequests)
    .innerJoin(sessions, eq(sessions.id, permissionRequests.sessionId))
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(eq(projects.spaceId, spaceId))
    .limit(1);
  // The space's default source (the oldest one), and its MCP registry (presets ensured when it is read).
  const [source] = await database.select({ id: githubSources.id }).from(githubSources).where(eq(githubSources.spaceId, spaceId)).orderBy(asc(githubSources.createdAt), asc(githubSources.id)).limit(1);
  expect((await request.get('/api/integrations/mcp')).status(), `registre MCP du compte ${key}`).toBe(200);
  const [mcp] = await database.select({ id: mcpServers.id }).from(mcpServers).where(and(eq(mcpServers.spaceId, spaceId), eq(mcpServers.name, 'figma'))).limit(1);
  const runId = seeded.runs?.passed?.id;
  const runs = runId ? [{ id: runId }] : ((await (await request.get(`/api/runs?projectId=${devis!.id}`)).json().catch(() => ({ items: [] }))) as { items?: Array<{ id: string }> }).items ?? [];
  const terminal = await request.post('/api/terminals', { data: { kind: 'shell', worktreeId: devis!.worktreeId }, headers: origin });
  expect(terminal.status(), `terminal du compte ${key}`).toBe(201);
  const envVar = await request.post(`/api/projects/${devis!.id}/env`, { data: { key: `ISOLATION_${key.toUpperCase()}`, value: 'valeur-de-test', secret: false }, headers: origin });
  const envBody = (await envVar.json().catch(() => ({}))) as { variable?: { id?: string }; id?: string };
  const [envRow] = await database.select({ id: projectEnvVars.id }).from(projectEnvVars).where(and(eq(projectEnvVars.projectId, devis!.id), eq(projectEnvVars.key, `ISOLATION_${key.toUpperCase()}`))).limit(1);
  // Real targets only: a missing one would silently compare two unknown ids. Account A has the full
  // seed (a permission asked, test runs); B's light seed may lack a permission or a run.
  const envVarId = envBody.variable?.id ?? envBody.id ?? envRow?.id;
  expect(envVarId, `variable du compte ${key}`).toBeTruthy();
  expect(source?.id, `source GitHub du compte ${key}`).toBeTruthy();
  expect(mcp?.id, `registre MCP du compte ${key}`).toBeTruthy();
  expect(devis!.operationId, `opération de clonage du compte ${key}`).toBeTruthy();
  if (key === 'a') {
    expect(pending?.id, 'autorisation du compte a (seed sessions)').toBeTruthy();
    expect(runs[0]?.id, 'lancement du compte a (seed runs)').toBeTruthy();
  }
  return {
    project: devis!.id,
    worktree: devis!.worktreeId,
    session: session!.id,
    permission: pending?.id ?? randomUUID(),
    run: runs[0]?.id ?? randomUUID(),
    operation: devis!.operationId || randomUUID(),
    terminal: ((await terminal.json()) as { terminal: { id: string } }).terminal.id,
    envVar: envVarId!,
    source: source!.id,
    mcp: mcp!.id,
  };
}

async function cleanup(request: APIRequestContext, ids: ForeignIds, key: 'a' | 'b') {
  await request.delete(`/api/terminals/${ids.terminal}`, { headers: origin }).catch(() => undefined);
  await database.delete(projectEnvVars).where(and(eq(projectEnvVars.projectId, ids.project), eq(projectEnvVars.key, `ISOLATION_${key.toUpperCase()}`))).catch(() => undefined);
}

async function snapshot(ids: ForeignIds) {
  const [project] = await database.select({ archivedAt: projects.archivedAt, isFavorite: projects.isFavorite, name: projects.name, status: projects.status }).from(projects).where(eq(projects.id, ids.project));
  const [session] = await database.select({ title: sessions.title, status: sessions.status, archivedAt: sessions.archivedAt }).from(sessions).where(eq(sessions.id, ids.session));
  const env = await database.select({ id: projectEnvVars.id, key: projectEnvVars.key }).from(projectEnvVars).where(eq(projectEnvVars.projectId, ids.project));
  const [permission] = await database.select({ status: permissionRequests.status, decidedAt: permissionRequests.decidedAt }).from(permissionRequests).where(eq(permissionRequests.id, ids.permission));
  const [run] = await database.select({ status: commandRuns.status }).from(commandRuns).where(eq(commandRuns.id, ids.run));
  const trees = await database.select({ id: worktrees.id, status: worktrees.status }).from(worktrees).where(eq(worktrees.projectId, ids.project));
  const [source] = await database.select({ label: githubSources.label, status: githubSources.status, lastCheckedAt: githubSources.lastCheckedAt }).from(githubSources).where(eq(githubSources.id, ids.source));
  const [mcp] = await database.select({ label: mcpServers.label, isEnabled: mcpServers.isEnabled, status: mcpServers.status, lastCheckedAt: mcpServers.lastCheckedAt }).from(mcpServers).where(eq(mcpServers.id, ids.mcp));
  return { project, session, env: env.map((row) => row.key).sort(), permission, run, worktrees: trees.sort((x, y) => x.id.localeCompare(y.id)), source, mcp };
}

test("B reçoit sur chaque route à identifiant de A exactement la réponse d'un identifiant inconnu", async ({ page, as, stack }) => {
  test.setTimeout(15 * 60_000);
  const b = await as('b');
  const userB = stack.accounts.find((account) => account.key === 'b')!.userId!;
  const ids = await resourcesOf(stack, 'a', page.request);
  try {
    const before = await snapshot(ids);
    const startedAt = new Date();
    const problems = await expectSameAsUnknown(b.page.request, PROBES, ids);
    // Soft: the checks of untouched data below still run when an answer differs.
    expect.soft(problems).toEqual([]);
    // Nothing of A changed, A's terminal still lives, no business audit row of B names A's resources.
    expect(await snapshot(ids)).toEqual(before);
    expect((await page.request.get(`/api/terminals/${ids.terminal}`)).status()).toBe(200);
    const audits = await database
      .select({ action: auditLog.action, targetId: auditLog.targetId, createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, userB), inArray(auditLog.targetId, Object.values(ids))));
    expect(audits.filter((row) => row.createdAt >= startedAt && !row.action.startsWith('security.'))).toEqual([]);
    // Nor any business row of B filed in A's space, whatever its target.
    const spaceA = stack.accounts.find((account) => account.key === 'a')!.spaceId!;
    const inSpaceA = await database.select({ action: auditLog.action, createdAt: auditLog.createdAt }).from(auditLog).where(and(eq(auditLog.actorUserId, userB), eq(auditLog.spaceId, spaceA)));
    expect(inSpaceA.filter((row) => row.createdAt >= startedAt && !row.action.startsWith('security.'))).toEqual([]);
  } finally {
    await cleanup(page.request, ids, 'a');
  }
});

test('le propriétaire (administrateur) ne voit pas davantage les ressources de B', async ({ page, as, stack }) => {
  test.setTimeout(15 * 60_000);
  const b = await as('b');
  const ids = await resourcesOf(stack, 'b', b.page.request);
  try {
    const before = await snapshot(ids);
    // Every probe, mutations included: an administrator manages accounts, never another space's content.
    const startedAt = new Date();
    const problems = await expectSameAsUnknown(page.request, PROBES, ids);
    expect.soft(problems).toEqual([]);
    expect(await snapshot(ids)).toEqual(before);
    expect((await b.page.request.get(`/api/terminals/${ids.terminal}`)).status()).toBe(200);
    const spaceB = stack.accounts.find((account) => account.key === 'b')!.spaceId!;
    const inSpaceB = await database.select({ action: auditLog.action, createdAt: auditLog.createdAt }).from(auditLog).where(and(eq(auditLog.actorUserId, stack.owner.userId!), eq(auditLog.spaceId, spaceB)));
    expect(inSpaceB.filter((row) => row.createdAt >= startedAt && !row.action.startsWith('security.'))).toEqual([]);
  } finally {
    await cleanup(b.page.request, ids, 'b');
  }
});

async function mainText(page: Page, url: string): Promise<{ status: number | null; text: string }> {
  const response = await page.goto(url);
  await page.waitForFunction(() => document.readyState === 'complete');
  // The page streams a skeleton first (« Chargement du projet… »): wait for its final content.
  const main = page.getByRole('main').first();
  await expect(main).not.toContainText(/^\s*Chargement/, { timeout: 60_000 });
  await expect(main.getByRole('heading').first()).toBeVisible({ timeout: 60_000 });
  const text = (await main.innerText()).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');
  return { status: response?.status() ?? null, text };
}

test("pages : un projet ou une session de A s'affichent pour B comme inconnus", async ({ as, stack }) => {
  const b = await as('b');
  const a = stack.seeded;
  const spaceA = stack.accounts.find((account) => account.key === 'a')!.spaceId!;
  const [figmaOfA] = await database.select({ id: mcpServers.id }).from(mcpServers).where(and(eq(mcpServers.spaceId, spaceA), eq(mcpServers.name, 'figma'))).limit(1);
  expect(figmaOfA, 'serveur MCP Figma du propriétaire').toBeTruthy();
  const pairs: Array<[string, string]> = [
    [`/projets/${a.projects!.devis!.id}`, `/projets/${randomUUID()}`],
    [`/projets/${a.projects!.devis!.id}?onglet=environnement`, `/projets/${randomUUID()}?onglet=environnement`],
    [`/workspace/${a.sessions!.running!.id}`, `/workspace/${randomUUID()}`],
    // The MCP page takes an id or a name: A's row id is unknown to B's registry.
    [`/integrations/mcp/${figmaOfA!.id}`, `/integrations/mcp/${randomUUID()}`],
  ];
  for (const [foreign, unknown] of pairs) {
    const theirs = await mainText(b.page, foreign);
    const nobody = await mainText(b.page, unknown);
    expect(theirs, foreign).toEqual(nobody);
    expect(theirs.text).not.toContain(a.projects!.devis!.path);
    expect(theirs.text).not.toContain(a.sessions!.running!.title);
  }
  // The neutral copy names the possibility of another account, never the owner of the id.
  await b.page.goto(`/projets/${a.projects!.devis!.id}`);
  await expect(b.page.getByText(/dépend d'un autre compte/)).toBeVisible();
  await expect(b.page.getByText(stack.owner.name)).toHaveCount(0);
});

test('les listes de B ne mélangent jamais les espaces', async ({ as, stack }) => {
  const b = await as('b');
  const a = stack.seeded;
  const aProjects = Object.values(a.projects ?? {}).map((project) => project.id);
  const aSessions = Object.values(a.sessions ?? {}).map((session) => session.id);
  const bSeeded = seededOf(stack, 'b');

  const list = (await (await b.page.request.get('/api/projects')).json()) as { items: Array<{ id: string; githubFullName?: string }> };
  expect(list.items.map((item) => item.id).filter((id) => aProjects.includes(id))).toEqual([]);
  // B tracks the same repository (atelier-test/devis-express) as A: B's own row, on B's server.
  expect(list.items.map((item) => item.id)).toContain(bSeeded.projects!.devis!.id);

  for (const query of ['?statut=active', '?statut=history']) {
    const response = await b.page.request.get(`/api/sessions${query}`);
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((item) => item.id).filter((id) => aSessions.includes(id)), query).toEqual([]);
  }

  const search = (await (await b.page.request.get('/api/search?q=devis')).json()) as { projects: Array<{ id: string }>; sessions: Array<{ id: string }> };
  expect(search.projects.map((item) => item.id).filter((id) => aProjects.includes(id))).toEqual([]);
  expect(search.sessions.map((item) => item.id).filter((id) => aSessions.includes(id))).toEqual([]);
  expect(search.projects.map((item) => item.id)).toContain(bSeeded.projects!.devis!.id);

  const aNotifications = a.notifications?.ids ?? [];
  const bell = (await (await b.page.request.get('/api/notifications')).json()) as { items: Array<{ id: string }> };
  expect(bell.items.map((item) => item.id).filter((id) => aNotifications.includes(id))).toEqual([]);

  const integrations = JSON.stringify(await (await b.page.request.get('/api/integrations')).json());
  // Exact slug (B's own app is « <slug>-b »).
  expect(integrations).not.toContain(`"${stack.github.slug}"`);
  expect(integrations).not.toContain('dev-test');

  const repos = (await (await b.page.request.get('/api/integrations/github/repos')).json()) as { repos: Array<{ fullName: string; alreadyCloned?: boolean; projectId?: string | null }> };
  expect(repos.repos.map((repo) => repo.fullName).filter((name) => name.startsWith('dev-test/'))).toEqual([]);
  // « Déjà cloné » comes from B's own rows: catalogue-produits is cloned by A only.
  const catalogue = repos.repos.find((repo) => repo.fullName === 'atelier-test/catalogue-produits');
  if (catalogue && 'alreadyCloned' in catalogue) expect(catalogue.alreadyCloned).toBe(false);

  await b.page.goto('/projets');
  await expect(b.page.getByRole('heading', { name: 'Projets', exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(b.page.getByText('Catalogue produits', { exact: true })).toHaveCount(0);
  await expect(b.page.getByText('Outils CLI', { exact: true })).toHaveCount(0);
});

test('les notifications de A restent non lues quand B tente de les marquer', async ({ as, stack }) => {
  const b = await as('b');
  const userA = stack.owner.userId!;
  const unreadOfA = () => database.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.userId, userA), isNull(notifications.readAt))).limit(1);
  let [unread] = await unreadOfA();
  if (!unread) {
    // The specs that ran before may have read them all: VPS-3 notifies A's space once more (real route, A's server token).
    const notify = await fetch(`${stack.urls.web}/api/internal/notify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${stack.secrets.runnerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'operation_succeeded', severity: 'success', title: 'Isolation : notification de A', body: 'Non lue, jamais marquée par B.' }),
    });
    expect(notify.status, await notify.text()).toBeLessThan(300);
    [unread] = await unreadOfA();
  }
  expect(unread, 'notification non lue du propriétaire').toBeTruthy();
  const response = await b.page.request.post('/api/notifications/read', { data: { ids: [unread!.id] }, headers: origin });
  expect(response.status()).toBe(200);
  // Another account's ids are neither touched nor counted.
  expect(((await response.json()) as { updated: number }).updated).toBe(0);
  const [after] = await database.select({ readAt: notifications.readAt }).from(notifications).where(eq(notifications.id, unread!.id));
  expect(after!.readAt).toBeNull();
  // Marking « all read » as B touches B's own notifications only.
  const all = await b.page.request.post('/api/notifications/read', { data: { all: true }, headers: origin });
  expect(all.status(), await all.text()).toBeLessThan(300);
  const [still] = await database.select({ readAt: notifications.readAt }).from(notifications).where(eq(notifications.id, unread!.id));
  expect(still!.readAt).toBeNull();
});

test('le flux de B reste muet pendant que A travaille', async ({ as, cli, stack }) => {
  test.setTimeout(5 * 60_000);
  const b = await as('b');
  const userB = stack.accounts.find((account) => account.key === 'b')!.userId!;
  const countsBefore = await (await b.page.request.get('/api/notifications/counts')).json();
  await b.page.goto('/');
  const serverA = stack.runners.find((runner) => runner.key === 'a')!.environmentId!;
  const serverB = stack.runners.find((runner) => runner.key === 'b')!.environmentId!;
  await b.page.evaluate((replayFromA) => {
    const listen = (url: string) => {
      const frames: string[] = [];
      const ids: string[] = [];
      const source = new EventSource(url);
      source.addEventListener('message', (event: MessageEvent<string>) => {
        frames.push(event.data);
        if (event.lastEventId) ids.push(event.lastEventId);
      });
      return { source, frames, ids };
    };
    const w = window as unknown as Record<string, unknown>;
    w.__live = listen('/api/stream/events');
    // A Last-Event-ID of A's server (as a tab of A would send): never replayed on B's stream, reset instead.
    w.__replay = listen(`/api/stream/events?lastEventId=${encodeURIComponent(replayFromA)}`);
  }, `${serverA}.1`);
  type Listener = { source: EventSource; frames: string[]; ids: string[] };
  const listener = (name: '__live' | '__replay') => b.page.evaluate((key) => {
    const value = (window as unknown as Record<string, Listener>)[key]!;
    return { state: value.source.readyState, frames: [...value.frames], ids: [...value.ids] };
  }, name);
  await expect.poll(async () => (await listener('__live')).state, { timeout: 60_000 }).toBe(1);
  await expect.poll(async () => (await listener('__replay')).frames.some((frame) => frame.includes('"stream.reset"')), { timeout: 60_000 }).toBe(true);

  const session = await cli.createSession({ title: `Travail de A pendant l'écoute de B ${Date.now().toString(36)}`, branch: 'test/isolation-flux' });
  try {
    const instruction = await cli.script('isolation-flux', {
      description: 'Un tour avec une autorisation demandée',
      steps: [{ say: 'Je travaille pour A.' }, { write: { file: 'docs/isolation-flux.md', content: '# A\n' } }, { final: 'Fini pour A.' }],
    });
    await cli.sendInstruction(session.id, instruction);
    const permission = await cli.waitForPermission(session.id);
    await cli.answerPermission(permission.id, 'allow');
    await cli.waitForTurn(session.id, instruction);
    await b.page.waitForTimeout(3_000);
    const ownerSessions = [session.id, permission.id, ...Object.values(stack.seeded.sessions ?? {}).map((item) => item.id)];
    for (const name of ['__live', '__replay'] as const) {
      const { frames, ids } = await listener(name);
      expect(frames.filter((frame) => ownerSessions.some((id) => frame.includes(id))), name).toEqual([]);
      // The hello frame names B, never A; every replayable id is namespaced by B's server.
      const hello = frames.map((frame) => JSON.parse(frame) as { type: string; data: { userId?: string } }).find((frame) => frame.type === 'stream.hello');
      expect(hello?.data.userId, `stream.hello (${name})`).toBe(userB);
      expect(ids.filter((id) => !id.startsWith(`${serverB}.`)), name).toEqual([]);
    }
    expect(await (await b.page.request.get('/api/notifications/counts')).json()).toEqual(countsBefore);
  } finally {
    await b.page
      .evaluate(() => {
        for (const key of ['__live', '__replay']) (window as unknown as Record<string, { source?: EventSource } | undefined>)[key]?.source?.close();
      })
      .catch(() => undefined);
    const api = await import('./fixtures').then((module) => module.stackRunnerApi('a'));
    await api('stopSession', { params: { sessionId: session.id }, body: { force: true } }).catch(() => undefined);
    if (session.worktreeId) await api('removeWorktree', { params: { worktreeId: session.worktreeId }, query: { force: true, deleteBranch: true } }).catch(() => undefined);
  }
});

test('le jeton du serveur de B ne donne accès à aucune ressource de A (routes internes, runner)', async ({ stack }) => {
  const runnerB = stack.runners.find((runner) => runner.key === 'b')!;
  const a = stack.seeded;
  const internal = (route: string, body: unknown) =>
    fetch(`${stack.urls.web}${route}`, { method: 'POST', headers: { authorization: `Bearer ${runnerB.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const credentials = await internal('/api/internal/git-credentials', { projectId: a.projects!.devis!.id, access: 'read' });
  expect(credentials.status).toBe(404);
  expect(await credentials.text()).not.toMatch(/ghs_|token/i);
  const headers = await internal('/api/internal/mcp-headers', { sessionId: a.sessions!.running!.id, serverName: 'github' });
  expect(headers.status).toBe(404);
  const notify = await internal('/api/internal/notify', { kind: 'operation_succeeded', severity: 'success', title: 'Intrus', body: 'Intrus', projectId: a.projects!.devis!.id });
  expect(notify.status).toBe(404);
  const [planted] = await database.select({ id: notifications.id }).from(notifications).where(eq(notifications.title, 'Intrus')).limit(1);
  expect(planted).toBeUndefined();

  // Runner B does not know A's ids (scoped lookups on its own server).
  const { stackRunnerApi } = await import('./fixtures');
  const apiB = await stackRunnerApi('b');
  for (const attempt of [
    () => apiB('getSession', { params: { sessionId: a.sessions!.running!.id } }),
    () => apiB('listBranches', { params: { projectId: a.projects!.devis!.id } }),
    () => apiB('worktreeChanges', { params: { worktreeId: a.projects!.devis!.worktreeId } }),
  ]) {
    const error = await attempt().then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RunnerApiError);
    expect((error as RunnerApiError).status).toBe(404);
  }
  // A's token on runner B is refused, and B's on runner A.
  const crossed = await fetch(`${runnerB.urls.runner}/v1/sessions`, { headers: { authorization: `Bearer ${stack.secrets.runnerToken}` } });
  expect(crossed.status).toBe(401);
  const reverse = await fetch(`${stack.urls.runner}/v1/sessions`, { headers: { authorization: `Bearer ${runnerB.token}` } });
  expect(reverse.status).toBe(401);
});
