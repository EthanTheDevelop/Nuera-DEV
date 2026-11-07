import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditLog, permissionRequests, projects, pullRequests, sessions, worktrees } from '@nuera/db/schema';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/server/auth/session';
import { closeSessionsTestDb, prepareSessionsTestDatabase } from '@/server/sessions/test/db';
import { startFakeRunner, terminalDto, type FakeRunner } from '@/server/tenancy/test/fake-runner';
import { createTestAccount, createTestResources, truncateTenancy, type TestAccount, type TestResources } from '@/server/tenancy/test/fixtures';

/*
 * Isolation of every route of the sessions / Workspace / terminals lot (docs/MULTICOMPTE.md §1.1,
 * §13): account B asking for an id of account A gets EXACTLY the answer of an unknown id (status
 * and body byte for byte), A's runner is never contacted, nothing is written, nothing journaled.
 * Real apiRoute (Origin, Zod, context), real database, two fake runners (one per server).
 * A route inventory guard makes sure no route of these folders escapes the table.
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

// GitHub and the MCP registry belong to other lots: recorded, never expected to be reached here.
const external = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/server/github', () => {
  const record = (name: string) => async () => {
    external.calls.push(name);
    throw new Error(`${name} ne doit pas être appelé`);
  };
  return {
    getGitAuthForProject: record('getGitAuthForProject'),
    createPullRequest: record('createPullRequest'),
    listProtectedBranches: record('listProtectedBranches'),
  };
});
vi.mock('@/server/mcp', () => ({
  buildSessionMcpConfig: async () => {
    external.calls.push('buildSessionMcpConfig');
    throw new Error('buildSessionMcpConfig ne doit pas être appelé');
  },
}));

const ORIGIN = 'http://localhost:3500';
const TOKEN = 'runner-token-for-w2-isolation-0123456789';
const TERMINAL_OF_A = 'termA_0123456789';
const TERMINAL_OF_SOMEONE = 'termX_0123456789';
const UNKNOWN_TERMINAL = 'termZ_0123456789';

let runnerA: FakeRunner;
let runnerB: FakeRunner;
let a: TestAccount;
let b: TestAccount;
let resA: TestResources;
let resB: TestResources;

beforeAll(async () => {
  await prepareSessionsTestDatabase('isolation');
  runnerA = await startFakeRunner();
  runnerB = await startFakeRunner();
});

afterAll(async () => {
  await runnerA.close();
  await runnerB.close();
  await closeSessionsTestDb();
});

beforeEach(async () => {
  vi.stubEnv('RUNNER_URL', runnerA.url);
  vi.stubEnv('RUNNER_TOKEN', TOKEN);
  vi.stubEnv('APP_URL', ORIGIN);
  vi.stubEnv('NUERA_RATE_LIMIT_FACTOR', '');
  const { rateLimiter } = await import('@/server/security/rate-limit');
  rateLimiter.reset();
  await truncateTenancy();
  a = await createTestAccount({ role: 'owner', name: 'Ethan Martin', email: 'ethan@example.test' });
  b = await createTestAccount({ role: 'member', name: 'Camille Laurent', email: 'camille@example.test', environment: { url: runnerB.url, name: 'VPS-4' } });
  resA = await createTestResources(a, 'nuera-os');
  resB = await createTestResources(b, 'nuera-os');
  external.calls.length = 0;
  runnerA.requests.length = 0;
  runnerB.requests.length = 0;
  // A's runner knows A's terminal; B's runner knows a terminal opened by someone else.
  runnerA.handle((req, res) => {
    if (req.url === `/v1/terminals/${TERMINAL_OF_A}`) return runnerA.json(res, 200, terminalDto({ id: TERMINAL_OF_A, ownerUserId: a.user.id }));
    runnerA.json(res, 500, { error: { code: 'INTERNAL', message: 'inattendu' } });
  });
  runnerB.handle((req, res) => {
    if (req.url === `/v1/terminals/${TERMINAL_OF_SOMEONE}`) return runnerB.json(res, 200, terminalDto({ id: TERMINAL_OF_SOMEONE, ownerUserId: 'user_someone_else' }));
    if (req.url?.startsWith('/v1/terminals/')) return runnerB.json(res, 404, { error: { code: 'NOT_FOUND', message: 'Terminal introuvable ou fermé.' } });
    if (req.url === `/v1/sessions/${resB.sessionId}/terminal`) return runnerB.json(res, 200, { terminalId: null, live: false });
    if (req.method === 'GET' && req.url === '/v1/sessions') return runnerB.json(res, 200, { sessions: [], capacity: { live: 0, max: 4 } });
    runnerB.json(res, 500, { error: { code: 'INTERNAL', message: 'inattendu' } });
  });
  state.current = b.user;
});

type Handler = (request: NextRequest, context: { params: Promise<unknown> }) => Promise<Response>;
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface RouteCase {
  /** Route file, relative to app/api. */
  file: string;
  method: Method;
  /** Route params for an id: the foreign one and an unknown one are both tried. */
  params: (id: string) => Record<string, string>;
  foreign: () => string;
  unknown: string;
  query?: string;
  body?: (id: string) => unknown;
  /** Expected status of both answers. */
  status: number;
}

const UNKNOWN_UUID = '0b0b0b0b-0000-4000-8000-0000000000ff';

const session = (file: string, method: Method, extra: Partial<RouteCase> = {}): RouteCase => ({
  file: `sessions/[sessionId]${file}/route.ts`,
  method,
  params: (id) => ({ sessionId: id }),
  foreign: () => resA.sessionId,
  unknown: UNKNOWN_UUID,
  status: 404,
  ...extra,
});
const worktree = (file: string, method: Method, extra: Partial<RouteCase> = {}): RouteCase => ({
  file: `worktrees/[worktreeId]/${file}/route.ts`,
  method,
  params: (id) => ({ worktreeId: id }),
  foreign: () => resA.worktreeId,
  unknown: UNKNOWN_UUID,
  status: 404,
  ...extra,
});
const terminal = (file: string, method: Method, extra: Partial<RouteCase> = {}): RouteCase => ({
  file: `terminals/[id]${file}/route.ts`,
  method,
  params: (id) => ({ id }),
  foreign: () => TERMINAL_OF_A,
  unknown: UNKNOWN_TERMINAL,
  status: 404,
  ...extra,
});

const CASES: RouteCase[] = [
  // Sessions
  { file: 'sessions/route.ts', method: 'POST', params: () => ({}), foreign: () => resA.projectId, unknown: UNKNOWN_UUID, body: (id) => ({ projectId: id, branch: { mode: 'primary' } }), status: 404 },
  session('', 'GET'),
  session('', 'PATCH', { body: () => ({ title: 'Volée' }) }),
  session('', 'DELETE'),
  session('/archive', 'POST'),
  session('/attachments', 'POST', { body: () => ({}) }),
  session('/composer', 'GET'),
  session('/auto-resume', 'POST', { body: () => ({ enabled: true }) }),
  session('/events', 'GET', { query: '?afterVersion=0' }),
  session('/instruction', 'POST', { body: () => ({ text: 'rm -rf /' }) }),
  session('/interrupt', 'POST'),
  session('/model', 'POST', { body: () => ({ model: 'opus' }) }),
  session('/effort', 'POST', { body: () => ({ effort: 'high' }) }),
  session('/permission-mode', 'POST', { body: () => ({ mode: 'plan' }) }),
  session('/resume', 'POST'),
  session('/resume', 'POST', { body: () => ({ context: true }) }),
  session('/stop', 'POST', { body: () => ({ force: true }) }),
  session('/terminal', 'GET'),
  // Permissions
  {
    file: 'permissions/[permissionId]/decision/route.ts',
    method: 'POST',
    params: (id) => ({ permissionId: id }),
    foreign: () => resA.permissionId,
    unknown: UNKNOWN_UUID,
    body: () => ({ optionId: 'allow' }),
    status: 404,
  },
  // Worktrees
  worktree('changes', 'GET'),
  worktree('commit', 'POST', { body: () => ({ message: 'vol', paths: ['a.js'] }) }),
  worktree('diff', 'GET', { query: '?path=a.js' }),
  worktree('file', 'GET', { query: '?path=a.js' }),
  worktree('pull-request', 'POST', { body: () => ({ title: 'Volée' }) }),
  worktree('push', 'POST', { body: () => ({}) }),
  worktree('stage', 'POST', { body: () => ({ paths: ['a.js'] }) }),
  worktree('status', 'GET'),
  worktree('tree', 'GET'),
  worktree('unstage', 'POST', { body: () => ({ paths: ['a.js'] }) }),
  // Terminals
  { file: 'terminals/route.ts', method: 'POST', params: () => ({}), foreign: () => resA.worktreeId, unknown: UNKNOWN_UUID, body: (id) => ({ kind: 'shell', worktreeId: id }), status: 404 },
  terminal('', 'GET'),
  // Closing is idempotent: someone else's terminal is « already gone » (204), untouched.
  terminal('', 'DELETE', { status: 204 }),
  terminal('/input', 'POST', { body: () => ({ data: 'ls\r' }) }),
  terminal('/resize', 'POST', { body: () => ({ cols: 90, rows: 30 }) }),
];

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function handlerOf(file: string, method: Method): Promise<Handler> {
  const routeModule = (await import(/* @vite-ignore */ `@/app/api/${file}`)) as Record<string, unknown>;
  const handler = routeModule[method];
  if (typeof handler !== 'function') throw new Error(`${method} absent de ${file}`);
  return handler as Handler;
}

async function call(routeCase: RouteCase, id: string): Promise<{ status: number; body: string }> {
  const handler = await handlerOf(routeCase.file, routeCase.method);
  const headers: Record<string, string> = { host: 'localhost:3500' };
  const body = routeCase.body?.(id);
  if (routeCase.method !== 'GET') headers.origin = ORIGIN;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = new NextRequest(`${ORIGIN}/api/${routeCase.file.replace(/\/route\.ts$/, '')}${routeCase.query ?? ''}`, {
    method: routeCase.method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handler(request, { params: Promise.resolve(routeCase.params(id)) });
  return { status: response.status, body: await response.text() };
}

async function snapshot() {
  const { db } = await import('@/server/db');
  return {
    projects: await db.select().from(projects),
    worktrees: await db.select().from(worktrees),
    sessions: await db.select().from(sessions),
    permissions: await db.select().from(permissionRequests),
    pullRequests: await db.select().from(pullRequests),
    audit: await db.select().from(auditLog),
  };
}

describe('isolation of the sessions, Workspace, permissions and terminals routes', () => {
  it('lists every route of these folders in the table (inventory guard)', async () => {
    const methods = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name === 'route.ts') found.push(path.relative(API_ROOT, full).replaceAll('\\', '/'));
      }
    };
    for (const folder of ['sessions', 'worktrees', 'permissions', 'terminals']) walk(path.join(API_ROOT, folder));
    const exported: string[] = [];
    for (const file of found) {
      const routeModule = (await import(/* @vite-ignore */ `@/app/api/${file}`)) as Record<string, unknown>;
      for (const method of methods) if (typeof routeModule[method] === 'function') exported.push(`${method} ${file}`);
    }
    // GET /api/sessions is a list (filtered by space, tested below), not an id lookup.
    const covered = new Set([...CASES.map((c) => `${c.method} ${c.file}`), 'GET sessions/route.ts']);
    expect(exported.filter((entry) => !covered.has(entry))).toEqual([]);
    expect([...covered].filter((entry) => !exported.includes(entry))).toEqual([]);
  });

  it.each(CASES.map((c) => [`${c.method} /api/${c.file.replace(/\/route\.ts$/, '')}`, c] as const))(
    '%s: an id of another account answers exactly like an unknown id',
    async (_name, routeCase) => {
      const before = await snapshot();
      const foreign = await call(routeCase, routeCase.foreign());
      const unknown = await call(routeCase, routeCase.unknown);
      expect(foreign.status).toBe(routeCase.status);
      expect(foreign).toEqual(unknown);
      const expectedBody = routeCase.status === 404 ? { error: { code: 'NOT_FOUND' } } : {};
      expect(foreign.body ? JSON.parse(foreign.body) : {}).toMatchObject(expectedBody);
      // A's server is never contacted; B's only for the terminal lookups (terminals live on runners).
      expect(runnerA.requests).toEqual([]);
      const isTerminal = routeCase.file.startsWith('terminals/[id]');
      expect(runnerB.requests.every((r) => isTerminal && r.method === 'GET' && r.path.startsWith('/v1/terminals/'))).toBe(true);
      expect(external.calls).toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it('refuses a terminal of the same server opened by another account like an unknown one', async () => {
    for (const routeCase of CASES.filter((c) => c.file.startsWith('terminals/[id]'))) {
      const foreign = await call(routeCase, TERMINAL_OF_SOMEONE);
      const unknown = await call(routeCase, UNKNOWN_TERMINAL);
      expect(foreign, routeCase.method + routeCase.file).toEqual(unknown);
    }
    // Nothing but lookups reached the runner: no keystroke, no resize, no close.
    expect(runnerB.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('never lists the sessions of another space (every filter, the search, the project filter)', async () => {
    const { db } = await import('@/server/db');
    // Each space gets the same history: a stopped (resumable) session and an archived one.
    const historyOf = async (account: TestAccount, resources: TestResources) => {
      const base = { projectId: resources.projectId, environmentId: account.environment!.id, worktreeId: resources.worktreeId };
      const [stopped] = await db
        .insert(sessions)
        .values({ ...base, id: crypto.randomUUID(), title: 'Export nuera', status: 'stopped', transcriptPath: '/s.jsonl', startedAt: new Date(), endedAt: new Date() })
        .returning({ id: sessions.id });
      const [archived] = await db
        .insert(sessions)
        .values({ ...base, id: crypto.randomUUID(), title: 'Ancienne nuera', status: 'archived', archivedAt: new Date(), startedAt: new Date() })
        .returning({ id: sessions.id });
      return { live: resources.sessionId, stopped: stopped!.id, archived: archived!.id };
    };
    const ofA = await historyOf(a, resA);
    const ofB = await historyOf(b, resB);
    const handler = await handlerOf('sessions/route.ts', 'GET');
    // Query → B's own sessions that must be there (the filters are not vacuous).
    const queries: Array<[string, string[]]> = [
      ['?statut=history&periode=tout', [ofB.stopped]],
      [`?statut=history&periode=tout&projet=${resA.projectId}`, []],
      // Both spaces have a project « nuera-os » and titles with « nuera »: the search never crosses the space.
      ['?statut=history&periode=tout&q=nuera', [ofB.stopped]],
      ['?statut=history&periode=tout&filtre=reprise-possible', [ofB.stopped]],
      ['?statut=history&periode=tout&filtre=reprise-impossible', []],
      ['?statut=history&periode=tout&filtre=archivees', [ofB.archived]],
      ['?statut=active', [ofB.live]],
    ];
    for (const [query, own] of queries) {
      const response = await handler(new NextRequest(`${ORIGIN}/api/sessions${query}`, { headers: { host: 'localhost:3500' } }), { params: Promise.resolve({}) });
      expect(response.status, query).toBe(200);
      const ids = ((await response.json()) as { items: Array<{ id: string }> }).items.map((item) => item.id);
      for (const id of Object.values(ofA)) expect(ids, query).not.toContain(id);
      for (const id of own) expect(ids, query).toContain(id);
    }
    expect(runnerA.requests).toEqual([]);
  });

  it('serves the same routes for the resources of the account itself, on its own server', async () => {
    const own = await call(session('/terminal', 'GET'), resB.sessionId);
    expect(own).toEqual({ status: 200, body: JSON.stringify({ terminalId: null, live: false }) });
    expect(runnerB.requests.map((r) => r.path)).toEqual([`/v1/sessions/${resB.sessionId}/terminal`]);
    expect(runnerA.requests).toEqual([]);
  });
});
