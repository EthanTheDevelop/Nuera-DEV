import {
  auditLog,
  commandRuns,
  githubSources,
  mcpServers,
  operations,
  projectEnvVars,
  projectMcpServers,
  projects,
  sessions,
  worktrees,
} from '@nuera/db/schema';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/server/auth/session';
import { closeWebTestDb, prepareWebTestDatabase, useTestEncryptionKey } from '@/server/tenancy/test/db';
import { startFakeRunner, type FakeRunner } from '@/server/tenancy/test/fake-runner';
import { createTestAccount, createTestResources, truncateTenancy, type TestAccount, type TestResources } from '@/server/tenancy/test/fixtures';

/*
 * Isolation of every route of the Projets lot (projects, runs, search), table-driven
 * (docs/MULTICOMPTE.md §1.1, §13): account B, signed in, sends the ids of account A's space. Each
 * answer must be byte for byte the answer to an UNKNOWN id (same status, same body), with no
 * request to either runner, no row written and no business audit. The lists (projects, counters,
 * search, destination check) never show A's rows to B.
 */

const state = vi.hoisted(() => ({ current: null as CurrentUser | null }));

vi.mock('@/server/auth/session', async () => {
  const { AppError } = await import('@/server/errors');
  return {
    getCurrentUser: async () => state.current,
    requireUser: async () => state.current,
    requireUserForApi: async () => {
      if (!state.current) throw new AppError('UNAUTHORIZED');
      return state.current;
    },
    isInstanceAdmin: (u: CurrentUser) => u.role === 'owner' || u.role === 'admin',
  };
});

const ORIGIN = 'http://localhost:3400';
const TOKEN = 'runner-token-for-w1-isolation-0123456789';
let runnerA: FakeRunner;
let runnerB: FakeRunner;
let a: TestAccount;
let b: TestAccount;
let resA: TestResources;
let resB: TestResources;
let envVarA: string;
let mcpServerA: string;
let sourceA: string;

type Handler = (request: NextRequest, context: { params: Promise<unknown> }) => Promise<Response>;
type RouteModule = Record<string, Handler | unknown>;

/** Ids sent in a request: A's (foreign) or fresh random ones (unknown). */
interface Ids {
  projectId: string;
  worktreeId: string;
  runId: string;
  envVarId: string;
  mcpServerId: string;
  mcpServerName: string;
}

interface Case {
  name: string;
  /** Route module, relative to this folder (inventory check). */
  file: string;
  load: () => Promise<RouteModule>;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: (ids: Ids) => string;
  params: (ids: Ids) => Record<string, string>;
  body?: (ids: Ids) => unknown;
}

const projectRoute = (suffix: string) => (ids: Ids) => `/api/projects/${ids.projectId}${suffix}`;
const onProject = (ids: Ids) => ({ projectId: ids.projectId });

const CASES: Case[] = [
  { name: 'GET /api/projects/[id]', file: './[projectId]/route', load: () => import('./[projectId]/route'), method: 'GET', url: projectRoute(''), params: onProject },
  { name: 'PATCH /api/projects/[id]', file: './[projectId]/route', load: () => import('./[projectId]/route'), method: 'PATCH', url: projectRoute(''), params: onProject, body: () => ({ name: 'Volé', favorite: true }) },
  { name: 'DELETE /api/projects/[id]', file: './[projectId]/route', load: () => import('./[projectId]/route'), method: 'DELETE', url: projectRoute(''), params: onProject, body: () => ({ removeClone: true }) },
  { name: 'GET /api/projects/[id]/archive', file: './[projectId]/archive/route', load: () => import('./[projectId]/archive/route'), method: 'GET', url: projectRoute('/archive'), params: onProject },
  { name: 'GET /api/projects/[id]/branches', file: './[projectId]/branches/route', load: () => import('./[projectId]/branches/route'), method: 'GET', url: projectRoute('/branches'), params: onProject },
  { name: 'POST /api/projects/[id]/branches', file: './[projectId]/branches/route', load: () => import('./[projectId]/branches/route'), method: 'POST', url: projectRoute('/branches'), params: onProject, body: () => ({ name: 'feature/x' }) },
  { name: 'POST /api/projects/[id]/checkout', file: './[projectId]/checkout/route', load: () => import('./[projectId]/checkout/route'), method: 'POST', url: projectRoute('/checkout'), params: onProject, body: () => ({ branch: 'main' }) },
  { name: 'GET /api/projects/[id]/claude-md', file: './[projectId]/claude-md/route', load: () => import('./[projectId]/claude-md/route'), method: 'GET', url: projectRoute('/claude-md'), params: onProject },
  { name: 'PUT /api/projects/[id]/claude-md', file: './[projectId]/claude-md/route', load: () => import('./[projectId]/claude-md/route'), method: 'PUT', url: projectRoute('/claude-md'), params: onProject, body: () => ({ content: '# x' }) },
  { name: 'POST /api/projects/[id]/clone', file: './[projectId]/clone/route', load: () => import('./[projectId]/clone/route'), method: 'POST', url: projectRoute('/clone'), params: onProject, body: () => ({}) },
  { name: 'DELETE /api/projects/[id]/clone', file: './[projectId]/clone/route', load: () => import('./[projectId]/clone/route'), method: 'DELETE', url: projectRoute('/clone'), params: onProject },
  { name: 'GET /api/projects/[id]/env', file: './[projectId]/env/route', load: () => import('./[projectId]/env/route'), method: 'GET', url: projectRoute('/env'), params: onProject },
  { name: 'POST /api/projects/[id]/env', file: './[projectId]/env/route', load: () => import('./[projectId]/env/route'), method: 'POST', url: projectRoute('/env'), params: onProject, body: () => ({ key: 'VOLE', value: 'x', secret: true }) },
  { name: 'PATCH /api/projects/[id]/env', file: './[projectId]/env/route', load: () => import('./[projectId]/env/route'), method: 'PATCH', url: projectRoute('/env'), params: onProject, body: (ids) => ({ id: ids.envVarId, value: 'x' }) },
  { name: 'DELETE /api/projects/[id]/env', file: './[projectId]/env/route', load: () => import('./[projectId]/env/route'), method: 'DELETE', url: projectRoute('/env'), params: onProject, body: (ids) => ({ id: ids.envVarId }) },
  { name: 'PUT /api/projects/[id]/mcp/[server]', file: './[projectId]/mcp/[server]/route', load: () => import('./[projectId]/mcp/[server]/route'), method: 'PUT', url: projectRoute('/mcp/figma'), params: (ids) => ({ projectId: ids.projectId, server: 'figma' }), body: () => ({ enabled: true }) },
  { name: 'POST /api/projects/[id]/restore', file: './[projectId]/restore/route', load: () => import('./[projectId]/restore/route'), method: 'POST', url: projectRoute('/restore'), params: onProject },
  { name: 'POST /api/projects/[id]/sync', file: './[projectId]/sync/route', load: () => import('./[projectId]/sync/route'), method: 'POST', url: projectRoute('/sync'), params: onProject },
  { name: 'GET /api/projects/[id]/worktrees', file: './[projectId]/worktrees/route', load: () => import('./[projectId]/worktrees/route'), method: 'GET', url: projectRoute('/worktrees'), params: onProject },
  {
    name: 'GET /api/projects/[id]/worktrees/[wt]',
    file: './[projectId]/worktrees/[worktreeId]/route', load: () => import('./[projectId]/worktrees/[worktreeId]/route'),
    method: 'GET',
    url: (ids) => `/api/projects/${ids.projectId}/worktrees/${ids.worktreeId}`,
    params: (ids) => ({ projectId: ids.projectId, worktreeId: ids.worktreeId }),
  },
  {
    name: 'DELETE /api/projects/[id]/worktrees/[wt]',
    file: './[projectId]/worktrees/[worktreeId]/route', load: () => import('./[projectId]/worktrees/[worktreeId]/route'),
    method: 'DELETE',
    url: (ids) => `/api/projects/${ids.projectId}/worktrees/${ids.worktreeId}?force=1&deleteBranch=1`,
    params: (ids) => ({ projectId: ids.projectId, worktreeId: ids.worktreeId }),
  },
  { name: 'POST /api/runs', file: '../runs/route', load: () => import('../runs/route'), method: 'POST', url: () => '/api/runs', params: () => ({}), body: (ids) => ({ projectId: ids.projectId, kind: 'custom', command: 'cat .env' }) },
  { name: 'GET /api/runs', file: '../runs/route', load: () => import('../runs/route'), method: 'GET', url: (ids) => `/api/runs?projectId=${ids.projectId}`, params: () => ({}) },
  { name: 'GET /api/runs/[id]', file: '../runs/[runId]/route', load: () => import('../runs/[runId]/route'), method: 'GET', url: (ids) => `/api/runs/${ids.runId}`, params: (ids) => ({ runId: ids.runId }) },
  { name: 'DELETE /api/runs/[id]', file: '../runs/[runId]/route', load: () => import('../runs/[runId]/route'), method: 'DELETE', url: (ids) => `/api/runs/${ids.runId}`, params: (ids) => ({ runId: ids.runId }) },
];

/** B's OWN project with one of A's ids below it (worktree, variable): still the unknown answer. */
const NESTED: Array<{ name: string; file: string; load: () => Promise<RouteModule>; method: Case['method']; url: (own: string, ids: Ids) => string; params: (own: string, ids: Ids) => Record<string, string>; body?: (own: string, ids: Ids) => unknown }> = [
  {
    name: 'GET /api/projects/[B]/worktrees/[A]',
    file: './[projectId]/worktrees/[worktreeId]/route', load: () => import('./[projectId]/worktrees/[worktreeId]/route'),
    method: 'GET',
    url: (own, ids) => `/api/projects/${own}/worktrees/${ids.worktreeId}`,
    params: (own, ids) => ({ projectId: own, worktreeId: ids.worktreeId }),
  },
  {
    name: 'DELETE /api/projects/[B]/worktrees/[A]',
    file: './[projectId]/worktrees/[worktreeId]/route', load: () => import('./[projectId]/worktrees/[worktreeId]/route'),
    method: 'DELETE',
    url: (own, ids) => `/api/projects/${own}/worktrees/${ids.worktreeId}?force=1`,
    params: (own, ids) => ({ projectId: own, worktreeId: ids.worktreeId }),
  },
  { name: 'PATCH /api/projects/[B]/env (variable A)', file: './[projectId]/env/route', load: () => import('./[projectId]/env/route'), method: 'PATCH', url: (own) => `/api/projects/${own}/env`, params: (own) => ({ projectId: own }), body: (_own, ids) => ({ id: ids.envVarId, value: 'x' }) },
  { name: 'DELETE /api/projects/[B]/env (variable A)', file: './[projectId]/env/route', load: () => import('./[projectId]/env/route'), method: 'DELETE', url: (own) => `/api/projects/${own}/env`, params: (own) => ({ projectId: own }), body: (_own, ids) => ({ id: ids.envVarId }) },
  {
    name: 'PUT /api/projects/[B]/mcp/[serveur MCP A, par id]',
    file: './[projectId]/mcp/[server]/route', load: () => import('./[projectId]/mcp/[server]/route'),
    method: 'PUT',
    url: (own, ids) => `/api/projects/${own}/mcp/${ids.mcpServerId}`,
    params: (own, ids) => ({ projectId: own, server: ids.mcpServerId }),
    body: () => ({ enabled: true }),
  },
  {
    name: 'PUT /api/projects/[B]/mcp/[serveur MCP A, par nom]',
    file: './[projectId]/mcp/[server]/route', load: () => import('./[projectId]/mcp/[server]/route'),
    method: 'PUT',
    url: (own, ids) => `/api/projects/${own}/mcp/${ids.mcpServerName}`,
    params: (own, ids) => ({ projectId: own, server: ids.mcpServerName }),
    body: () => ({ enabled: true }),
  },
  {
    name: 'POST /api/runs (projet B, worktree A)',
    file: '../runs/route', load: () => import('../runs/route'),
    method: 'POST',
    url: () => '/api/runs',
    params: () => ({}),
    body: (own, ids) => ({ projectId: own, worktreeId: ids.worktreeId, kind: 'custom', command: 'ls' }),
  },
];

function request(method: Case['method'], url: string, body: unknown): NextRequest {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers.origin = ORIGIN;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`${ORIGIN}${url}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

async function call(load: () => Promise<RouteModule>, method: Case['method'], url: string, params: Record<string, string>, body: unknown): Promise<{ status: number; text: string }> {
  const handler = (await load())[method] as Handler;
  const response = await handler(request(method, url, body), { params: Promise.resolve(params) });
  return { status: response.status, text: await response.text() };
}

const unknownIds = (): Ids => ({
  projectId: crypto.randomUUID(),
  worktreeId: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  envVarId: crypto.randomUUID(),
  mcpServerId: crypto.randomUUID(),
  mcpServerName: `inconnu-${crypto.randomUUID().slice(0, 8)}`,
});

const foreignIds = (): Ids => ({
  projectId: resA.projectId,
  worktreeId: resA.worktreeId,
  runId: resA.runId,
  envVarId: envVarA,
  mcpServerId: mcpServerA,
  mcpServerName: 'secret-a-mcp',
});

async function snapshot(): Promise<string> {
  const { db } = await import('@/server/db');
  const [p, w, s, r, o, e, journal, mcp, projectMcp, sources] = await Promise.all([
    db.select().from(projects).orderBy(projects.id),
    db.select().from(worktrees).orderBy(worktrees.id),
    db.select().from(sessions).orderBy(sessions.id),
    db.select().from(commandRuns).orderBy(commandRuns.id),
    db.select().from(operations).orderBy(operations.id),
    db.select().from(projectEnvVars).orderBy(projectEnvVars.id),
    db.select().from(auditLog).orderBy(auditLog.id),
    db.select().from(mcpServers).orderBy(mcpServers.id),
    db.select().from(projectMcpServers).orderBy(projectMcpServers.projectId, projectMcpServers.mcpServerId),
    db.select().from(githubSources).orderBy(githubSources.id),
  ]);
  return JSON.stringify({ p, w, s, r, o, e, journal, mcp, projectMcp, sources });
}

beforeAll(async () => {
  useTestEncryptionKey();
  await prepareWebTestDatabase('nuera_w1_isolation');
  runnerA = await startFakeRunner();
  runnerB = await startFakeRunner();
});

afterAll(async () => {
  await runnerA.close();
  await runnerB.close();
  await closeWebTestDb();
});

beforeEach(async () => {
  vi.stubEnv('RUNNER_URL', runnerA.url);
  vi.stubEnv('RUNNER_TOKEN', TOKEN);
  vi.stubEnv('APP_URL', ORIGIN);
  vi.stubEnv('NUERA_RATE_LIMIT_FACTOR', '100');
  await truncateTenancy();
  a = await createTestAccount({ role: 'owner', name: 'Ethan Martin', email: 'ethan@example.test' });
  b = await createTestAccount({ role: 'member', name: 'Camille Laurent', email: 'camille@example.test', environment: { configSource: 'db', name: 'VPS-4', url: runnerB.url } });
  resA = await createTestResources(a, 'secret-a');
  resB = await createTestResources(b, 'nuera-os');
  const { db } = await import('@/server/db');
  const { eq } = await import('drizzle-orm');
  const { encryptSecret, SecretScopes } = await import('@/server/security/crypto');
  await db.update(projects).set({ commands: { test: 'npm test' } }).where(eq(projects.id, resA.projectId));
  const [variable] = await db
    .insert(projectEnvVars)
    .values({ projectId: resA.projectId, key: 'DATABASE_URL', valueEncrypted: encryptSecret('postgres://secret-de-a', SecretScopes.projectEnvVar(resA.projectId, 'DATABASE_URL')), isSecret: false })
    .returning();
  envVarA = variable!.id;
  // Registries of both spaces already seeded (reading one seeds its presets idempotently).
  const { ensurePresetServers } = await import('@/server/mcp');
  await ensurePresetServers(a.space.id);
  await ensurePresetServers(b.space.id);
  const [mcp] = await db
    .insert(mcpServers)
    .values({ spaceId: a.space.id, name: 'secret-a-mcp', label: 'MCP secret de A', transport: 'http', url: 'https://mcp.secret-a.example.test/mcp' })
    .returning();
  mcpServerA = mcp!.id;
  const [source] = await db
    .insert(githubSources)
    .values({ spaceId: a.space.id, label: 'Source secrète de A', appId: 424242, ownerLogin: 'secret-a', ownerType: 'Organization', status: 'connected' })
    .returning();
  sourceA = source!.id;
  for (const runner of [runnerA, runnerB]) {
    runner.requests.length = 0;
    runner.handle((_req, res) => runner.json(res, 500, { error: { code: 'INTERNAL', message: 'Le runner ne devait pas être appelé.' } }));
  }
  state.current = b.user;
});

describe("B sur les identifiants de l'espace A : la réponse d'un identifiant inconnu", () => {
  it.each(CASES.map((item) => [item.name, item] as const))('%s', async (_name, item) => {
    const ids = foreignIds();
    const missingIds = unknownIds();
    const before = await snapshot();
    const foreign = await call(item.load, item.method, item.url(ids), item.params(ids), item.body?.(ids));
    const missing = await call(item.load, item.method, item.url(missingIds), item.params(missingIds), item.body?.(missingIds));
    expect(foreign.status).toBe(404);
    expect(foreign).toEqual(missing);
    expect(foreign.text).not.toContain('secret-a');
    expect(runnerA.requests).toHaveLength(0);
    expect(runnerB.requests).toHaveLength(0);
    expect(await snapshot()).toBe(before);
  });

  it.each(NESTED.map((item) => [item.name, item] as const))('%s', async (_name, item) => {
    const ids = foreignIds();
    const missingIds = unknownIds();
    const own = resB.projectId;
    const before = await snapshot();
    const foreign = await call(item.load, item.method, item.url(own, ids), item.params(own, ids), item.body?.(own, ids));
    const missing = await call(item.load, item.method, item.url(own, missingIds), item.params(own, missingIds), item.body?.(own, missingIds));
    expect(foreign).toEqual(missing);
    expect(foreign.text).not.toContain('secret');
    expect(runnerA.requests).toHaveLength(0);
    expect(runnerB.requests).toHaveLength(0);
    expect(await snapshot()).toBe(before);
  });

  it('the table covers every (method, route) of the lot', async () => {
    const { readdir } = await import('node:fs/promises');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '..');
    const exported = new Set<string>();
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name === 'route.ts') {
          const relative = path.relative(root, full).split(path.sep).join('/');
          const mod = (await import(/* @vite-ignore */ full)) as RouteModule;
          for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) if (typeof mod[method] === 'function') exported.add(`${method} ${relative}`);
        }
      }
    };
    for (const dir of ['projects', 'runs', 'search']) await walk(path.join(root, dir));
    // Routes without an id of a resource: checked by the list tests below.
    const lists = new Set([
      'GET projects/route.ts',
      'POST projects/route.ts',
      'GET projects/repos/route.ts',
      'GET projects/repos/preview/route.ts',
      'GET projects/destination-check/route.ts',
      'GET search/route.ts',
    ]);
    const covered = new Set<string>();
    for (const item of [...CASES, ...NESTED]) {
      const relative = path.relative(root, path.resolve(__dirname, item.file)).split(path.sep).join('/');
      covered.add(`${item.method} ${relative}.ts`);
    }
    expect(exported.size).toBe(covered.size + lists.size);
    const missing = [...exported].filter((route) => !covered.has(route) && !lists.has(route));
    expect(missing).toEqual([]);
  });
});

describe("listes de l'espace B", () => {
  it("GET /api/projects ne liste ni ne compte les projets de A, et lit le disque du serveur de B", async () => {
    runnerB.handle((_req, res) => runnerB.json(res, 503, { error: { code: 'INTERNAL', message: 'indisponible' } }));
    const result = await call(() => import('./route'), 'GET', '/api/projects', {}, undefined);
    expect(result.status).toBe(200);
    const body = JSON.parse(result.text) as { items: Array<{ id: string }>; counts: Record<string, number>; environment: { name: string } };
    expect(body.items.map((item) => item.id)).toEqual([resB.projectId]);
    expect(body.counts).toEqual({ all: 1, favorites: 0, archived: 0 });
    expect(body.environment.name).toBe('VPS-4');
    expect(result.text).not.toContain(resA.projectId);
    expect(runnerA.requests).toHaveLength(0);
  });

  it("GET /api/search ne trouve ni les projets ni les sessions de A", async () => {
    const result = await call(() => import('../search/route'), 'GET', '/api/search?q=secret', {}, undefined);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toMatchObject({ projects: [], sessions: [] });
    const own = JSON.parse((await call(() => import('../search/route'), 'GET', '/api/search?q=nuera-os', {}, undefined)).text) as { projects: Array<{ id: string }> };
    expect(own.projects.map((item) => item.id)).toEqual([resB.projectId]);
  });

  it("GET /api/projects/destination-check ne révèle jamais le projet de A au même chemin", async () => {
    runnerB.handle((_req, res, recorded) =>
      runnerB.json(res, 200, { path: JSON.parse(recorded.body).path, available: false, exists: true, empty: false, fileCount: 3, suggestedPath: '/srv/dev/secret-a-2', existingClone: null }),
    );
    const result = await call(() => import('./destination-check/route'), 'GET', '/api/projects/destination-check?chemin=/srv/dev/secret-a', {}, undefined);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toMatchObject({ path: '/srv/dev/secret-a', existingProject: null });
    expect(runnerA.requests).toHaveLength(0);
    expect(runnerB.requests).toHaveLength(1);
  });

  it("une source GitHub de A ne sert ni à lire ni à cloner un dépôt pour B (réponse d'une source inconnue)", async () => {
    const preview = (source: string) =>
      call(() => import('./repos/preview/route'), 'GET', `/api/projects/repos/preview?depot=secret-a/app&source=${source}`, {}, undefined);
    const create = (source: string) =>
      call(() => import('./route'), 'POST', '/api/projects', {}, {
        fullName: 'secret-a/app',
        sourceId: source,
        name: 'App',
        destination: 'app',
        installDeps: true,
        worktreePerSession: true,
        readClaudeMd: true,
        commands: {},
      });
    const before = await snapshot();
    const foreignPreview = await preview(sourceA);
    const missingPreview = await preview(crypto.randomUUID());
    expect(foreignPreview.status).toBe(404);
    expect(foreignPreview).toEqual(missingPreview);
    const foreignCreate = await create(sourceA);
    const missingCreate = await create(crypto.randomUUID());
    expect(foreignCreate.status).toBe(404);
    expect(foreignCreate).toEqual(missingCreate);
    expect(foreignCreate.text + foreignPreview.text).not.toContain('Source secrète');
    expect(runnerA.requests).toHaveLength(0);
    expect(runnerB.requests).toHaveLength(0);
    expect(await snapshot()).toBe(before);
  });

  it("un compte sans serveur reçoit NO_ENVIRONMENT, sans appel au runner", async () => {
    const lonely = await createTestAccount({ role: 'member', name: 'Sans Serveur', email: 'sans@example.test', environment: false });
    state.current = lonely.user;
    const result = await call(() => import('./destination-check/route'), 'GET', '/api/projects/destination-check?chemin=x', {}, undefined);
    expect(result.status).toBe(409);
    expect(JSON.parse(result.text)).toMatchObject({ error: { code: 'CONFLICT', reason: 'NO_ENVIRONMENT' } });
    const created = await call(
      () => import('./route'),
      'POST',
      '/api/projects',
      {},
      { fullName: 'atelier/x', name: 'X', destination: 'x', installDeps: true, worktreePerSession: true, readClaudeMd: true, commands: {} },
    );
    expect(created.status).toBe(409);
    expect(JSON.parse(created.text)).toMatchObject({ error: { reason: 'NO_ENVIRONMENT' } });
    expect(runnerA.requests).toHaveLength(0);
    expect(runnerB.requests).toHaveLength(0);
  });
});
