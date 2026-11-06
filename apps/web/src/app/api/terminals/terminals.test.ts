import { auditLog, projects, worktrees } from '@nuera/db/schema';
import type { TerminalDto } from '@nuera/shared/runner';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeSessionsTestDb,
  prepareSessionsTestDatabase,
  resetSessionTables,
  testContext,
  TEST_ENVIRONMENT_ID,
  TEST_SPACE_ID,
  TEST_USER_ID,
} from '@/server/sessions/test/db';

/*
 * Route handlers of the terminal lot: POST /api/terminals, GET + DELETE /api/terminals/[id],
 * POST …/input and …/resize. Real apiRoute (Origin check, Zod, context, errors), real database
 * (worktree scope, audit), session and runner doubles (the client of the space's server).
 * Isolation between accounts: src/app/api/sessions/isolation.test.ts.
 */
const state = vi.hoisted(() => ({
  signedIn: true,
  calls: [] as Array<{ name: string; input: unknown }>,
  servers: [] as string[],
  failNext: null as null | { name?: string; code: string; message: string; status?: number },
  owner: null as null | string,
}));

vi.mock('@/server/auth/session', async () => {
  const { AppError } = await import('@/server/errors');
  const { testContext: context } = await import('@/server/sessions/test/db');
  const current = () => context().user;
  return {
    getCurrentUser: async () => (state.signedIn ? current() : null),
    requireUser: async () => current(),
    requireUserForApi: async () => {
      if (!state.signedIn) throw new AppError('UNAUTHORIZED');
      return current();
    },
    isInstanceAdmin: () => true,
  };
});

vi.mock('@/server/runner/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/runner/client')>();
  const dto = (overrides: Partial<TerminalDto>): TerminalDto => ({
    id: 'term_0123456789',
    kind: 'shell',
    title: 'Terminal',
    cwd: null,
    worktreeId: null,
    sessionId: null,
    cols: 120,
    rows: 32,
    alive: true,
    exitCode: null,
    private: false,
    subscribers: 0,
    createdAt: '2026-11-05T10:00:00.000Z',
    lastActivityAt: '2026-11-05T10:00:00.000Z',
    ...overrides,
  });
  const record = (name: string, input: unknown) => {
    state.calls.push({ name, input });
    const failure = state.failNext;
    if (failure && (!failure.name || failure.name === name)) {
      state.failNext = null;
      throw new original.RunnerError(failure.code as never, failure.message, failure.status ? { status: failure.status } : {});
    }
  };
  const client = {
    createTerminal: async (input: { body: { kind: TerminalDto['kind']; worktreeId?: string; cols?: number; rows?: number; actorUserId?: string | null } }) => {
      record('createTerminal', input);
      const { kind, worktreeId } = input.body;
      return dto({ kind, worktreeId: worktreeId ?? null, private: kind !== 'shell', cols: input.body.cols ?? 120, rows: input.body.rows ?? 32, ownerUserId: input.body.actorUserId ?? null });
    },
    getTerminal: async (input: { params: { terminalId: string } }) => {
      record('getTerminal', input);
      return dto({ id: input.params.terminalId, ...(state.owner ? { ownerUserId: state.owner } : {}) });
    },
    closeTerminal: async (input: unknown) => {
      record('closeTerminal', input);
      return { ok: true };
    },
    terminalInput: async (input: unknown) => {
      record('terminalInput', input);
      return { ok: true };
    },
    terminalResize: async (input: unknown) => {
      record('terminalResize', input);
      return { ok: true };
    },
  };
  return {
    ...original,
    getRunnerForEnvironment: (environmentId: string) => {
      state.servers.push(environmentId);
      return client;
    },
  };
});

const ORIGIN = 'http://localhost:3202';

beforeAll(async () => {
  await prepareSessionsTestDatabase('terminals');
  vi.stubEnv('APP_URL', ORIGIN);
});

afterAll(async () => {
  await closeSessionsTestDb();
});

beforeEach(async () => {
  await resetSessionTables();
  const { rateLimiter } = await import('@/server/security/rate-limit');
  rateLimiter.reset();
  state.signedIn = true;
  state.calls = [];
  state.servers = [];
  state.failNext = null;
  state.owner = null;
  vi.stubEnv('APP_URL', ORIGIN);
  vi.stubEnv('NUERA_RATE_LIMIT_FACTOR', '');
});

type Handler = (request: NextRequest, context: { params: Promise<unknown> }) => Promise<Response>;

const routes = async () => ({
  create: (await import('./route')).POST as Handler,
  get: (await import('./[id]/route')).GET as Handler,
  remove: (await import('./[id]/route')).DELETE as Handler,
  input: (await import('./[id]/input/route')).POST as Handler,
  resize: (await import('./[id]/resize/route')).POST as Handler,
});

async function call(
  handler: Handler,
  path: string,
  options: { method?: string; body?: unknown; origin?: string | null; params?: Record<string, string> } = {},
): Promise<Response> {
  const method = options.method ?? 'POST';
  const headers: Record<string, string> = { host: 'localhost:3202' };
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const request = new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return handler(request, { params: Promise.resolve(options.params ?? {}) });
}

async function seedWorktree(status: 'active' | 'removed' = 'active', projectValues: Partial<typeof projects.$inferInsert> = {}) {
  const { db } = await import('@/server/db');
  const [project] = await db
    .insert(projects)
    .values({
      spaceId: TEST_SPACE_ID,
      environmentId: TEST_ENVIRONMENT_ID,
      slug: 'nuera-os',
      name: 'Nuera OS',
      githubFullName: 'nuera-studio/nuera-os',
      cloneUrl: 'https://github.com/nuera-studio/nuera-os.git',
      path: '/srv/dev/nuera-os',
      status: 'ready',
      ...projectValues,
    })
    .returning();
  const [worktree] = await db
    .insert(worktrees)
    .values({
      projectId: project!.id,
      environmentId: TEST_ENVIRONMENT_ID,
      name: 'crm-core',
      branch: 'feature/crm-core',
      path: '/srv/dev/.worktrees/nuera-os/crm-core',
      status,
      ...(status === 'removed' ? { removedAt: new Date() } : {}),
    })
    .returning();
  return { project: project!, worktree: worktree! };
}

async function auditRows() {
  const { db } = await import('@/server/db');
  return db.select().from(auditLog).where(eq(auditLog.action, 'terminal.open'));
}

const json = async <T>(response: Response) => (await response.json()) as T;
const IDENTITY = { name: 'Camille Laurent', email: 'owner@example.test' };

describe('POST /api/terminals', () => {
  it('requires the session', async () => {
    const { create } = await routes();
    state.signedIn = false;
    const response = await call(create, '/api/terminals', { body: { kind: 'claude-status' } });
    expect(response.status).toBe(401);
    expect(state.calls).toEqual([]);
  });

  it('refuses another origin or a missing one (CSRF), before anything runs', async () => {
    const { create } = await routes();
    for (const origin of ['https://evil.example', null]) {
      const response = await call(create, '/api/terminals', { body: { kind: 'claude-login' }, origin });
      expect(response.status, String(origin)).toBe(403);
      expect((await json<{ error: { code: string } }>(response)).error.code).toBe('FORBIDDEN');
    }
    expect(state.calls).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });

  it('validates the body: kinds opened elsewhere, unknown fields, sizes, worktree id', async () => {
    const { create } = await routes();
    const invalid = [
      { kind: 'mcp-login', serverName: 'figma' },
      { kind: 'session' },
      { kind: 'bash' },
      {},
      { kind: 'shell' },
      { kind: 'shell', worktreeId: 'pas-un-uuid' },
      { kind: 'claude-login', command: 'rm -rf /' },
      { kind: 'claude-login', actorUserId: 'someone-else' },
      { kind: 'claude-status', cols: 5000 },
      { kind: 'claude-status', rows: 2 },
    ];
    for (const body of invalid) {
      const response = await call(create, '/api/terminals', { body });
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect((await json<{ error: { code: string } }>(response)).error.code).toBe('VALIDATION');
    }
    const mcp = await call(create, '/api/terminals', { body: { kind: 'mcp-login', serverName: 'figma' } });
    expect((await json<{ error: { detail?: string } }>(mcp)).error.detail).toMatch(/Intégrations/);
    expect(state.calls).toEqual([]);
  });

  it('opens a shell only in an existing, non-removed worktree of the space, with the account and its Git identity, and audits it', async () => {
    const { create } = await routes();
    const unknown = await call(create, '/api/terminals', { body: { kind: 'shell', worktreeId: crypto.randomUUID() } });
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.text();
    const removed = await seedWorktree('removed');
    const gone = await call(create, '/api/terminals', { body: { kind: 'shell', worktreeId: removed.worktree.id } });
    expect(gone.status).toBe(404);
    expect(await gone.text()).toBe(unknownBody);
    expect(JSON.parse(unknownBody)).toEqual({
      error: { code: 'NOT_FOUND', message: 'Worktree introuvable : il a peut-être été supprimé.', untouched: 'Aucun terminal ouvert.' },
    });
    expect(state.calls).toEqual([]);

    await resetSessionTables();
    const archived = await seedWorktree('active', { archivedAt: new Date(), status: 'archived' });
    const ofArchived = await call(create, '/api/terminals', { body: { kind: 'shell', worktreeId: archived.worktree.id } });
    expect(ofArchived.status).toBe(404);
    expect(await ofArchived.text()).toBe(unknownBody);

    await resetSessionTables();
    const { worktree, project } = await seedWorktree('active');
    const response = await call(create, '/api/terminals', { body: { kind: 'shell', worktreeId: worktree.id, cols: 100, rows: 30 } });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const { terminal } = await json<{ terminal: TerminalDto }>(response);
    expect(terminal).toMatchObject({ kind: 'shell', worktreeId: worktree.id, cols: 100, rows: 30, ownerUserId: TEST_USER_ID });
    expect(state.calls).toEqual([
      { name: 'createTerminal', input: { body: { kind: 'shell', worktreeId: worktree.id, cols: 100, rows: 30, actorUserId: TEST_USER_ID, gitIdentity: IDENTITY } } },
    ]);
    expect(new Set(state.servers)).toEqual(new Set([TEST_ENVIRONMENT_ID]));

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: TEST_USER_ID,
      spaceId: TEST_SPACE_ID,
      environmentId: TEST_ENVIRONMENT_ID,
      targetType: 'worktree',
      targetId: worktree.id,
      summary: 'terminal ouvert dans le worktree « crm-core » · Nuera OS',
    });
    expect(rows[0]!.metadata).toMatchObject({ kind: 'shell', terminalId: terminal.id, projectId: project.id });
  });

  it('opens the login and /status terminals (private) on the space server for its owner, audited without any terminal content', async () => {
    const { create } = await routes();
    const login = await call(create, '/api/terminals', { body: { kind: 'claude-login' } });
    expect(login.status).toBe(201);
    expect((await json<{ terminal: TerminalDto }>(login)).terminal).toMatchObject({ kind: 'claude-login', private: true });
    const status = await call(create, '/api/terminals', { body: { kind: 'claude-status' } });
    expect(status.status).toBe(201);
    expect(state.calls.map((c) => c.input)).toEqual([
      { body: { kind: 'claude-login', actorUserId: TEST_USER_ID, spaceId: TEST_SPACE_ID } },
      { body: { kind: 'claude-status', actorUserId: TEST_USER_ID, spaceId: TEST_SPACE_ID } },
    ]);
    expect(new Set(state.servers)).toEqual(new Set([TEST_ENVIRONMENT_ID]));
    const rows = await auditRows();
    expect(rows.map((row) => row.summary).sort()).toEqual(['terminal Claude Code ouvert pour /status', 'terminal de connexion à Claude Code ouvert (claude auth login)']);
    for (const row of rows) expect(row).toMatchObject({ spaceId: TEST_SPACE_ID, environmentId: TEST_ENVIRONMENT_ID });
  });

  it('rate-limits login terminals per account', async () => {
    const { create } = await routes();
    for (let i = 0; i < 5; i += 1) {
      expect((await call(create, '/api/terminals', { body: { kind: 'claude-login' } })).status).toBe(201);
    }
    const limited = await call(create, '/api/terminals', { body: { kind: 'claude-login' } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(state.calls).toHaveLength(5);
    // Other kinds keep their own budget.
    expect((await call(create, '/api/terminals', { body: { kind: 'claude-status' } })).status).toBe(201);
  });

  it('passes the runner errors through (unreachable, CLI missing)', async () => {
    const { create } = await routes();
    state.failNext = { code: 'RUNNER_UNAVAILABLE', message: 'VPS-3 ne répond pas : le runner est injoignable.' };
    const down = await call(create, '/api/terminals', { body: { kind: 'claude-status' } });
    expect(down.status).toBe(503);
    expect((await json<{ error: { code: string } }>(down)).error.code).toBe('RUNNER_UNAVAILABLE');
    state.failNext = { code: 'CONFLICT', message: 'Le CLI Claude Code est introuvable sur le serveur.' };
    const missing = await call(create, '/api/terminals', { body: { kind: 'claude-login' } });
    expect(missing.status).toBe(409);
    expect((await json<{ error: { message: string } }>(missing)).error.message).toBe('Le CLI Claude Code est introuvable sur le serveur.');
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('login terminals: owner of the space, on its server', () => {
  it('refuses without a server (NO_ENVIRONMENT) and for a member who does not own the space', async () => {
    const { requireLoginTerminalServer, LOGIN_TERMINAL_OWNER_ONLY } = await import('@/server/terminals');
    const ctx = testContext();
    expect(() => requireLoginTerminalServer({ ...ctx, environment: null })).toThrow(expect.objectContaining({ code: 'CONFLICT', reason: 'NO_ENVIRONMENT' }));
    expect(() => requireLoginTerminalServer({ ...ctx, space: { ...ctx.space, role: 'member' } })).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', message: LOGIN_TERMINAL_OWNER_ONLY }),
    );
    expect(requireLoginTerminalServer(ctx).environment.id).toBe(TEST_ENVIRONMENT_ID);
  });

  it('opens a shell only through the server of the space: none assigned, or a worktree held by another server', async () => {
    const { openTerminal } = await import('@/server/terminals');
    const { worktree } = await seedWorktree('active');
    const ctx = testContext();
    await expect(openTerminal({ ...ctx, environment: null }, { kind: 'shell', worktreeId: worktree.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      reason: 'NO_ENVIRONMENT',
    });
    const elsewhere = { ...ctx.environment!, id: crypto.randomUUID(), name: 'VPS-4' };
    await expect(openTerminal({ ...ctx, environment: elsewhere }, { kind: 'shell', worktreeId: worktree.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: "Ce worktree est sur VPS-3, qui n'est plus le serveur de votre espace.",
      untouched: 'Aucun terminal ouvert.',
    });
    expect(state.calls).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('GET / DELETE /api/terminals/[id]', () => {
  it('returns a terminal of the account, validates the id', async () => {
    const { get } = await routes();
    state.owner = TEST_USER_ID;
    const ok = await call(get, '/api/terminals/term_0123456789', { method: 'GET', origin: null, params: { id: 'term_0123456789' } });
    expect(ok.status).toBe(200);
    expect((await json<{ terminal: TerminalDto }>(ok)).terminal.id).toBe('term_0123456789');
    const bad = await call(get, '/api/terminals/x', { method: 'GET', origin: null, params: { id: '../etc' } });
    expect(bad.status).toBe(422);
    state.failNext = { code: 'NOT_FOUND', message: 'Terminal introuvable ou fermé.' };
    const gone = await call(get, '/api/terminals/term_0123456789', { method: 'GET', origin: null, params: { id: 'term_0123456789' } });
    expect(gone.status).toBe(404);
    const goneBody = await gone.text();
    // Opened by another account: the same 404 as a terminal the runner does not know.
    state.owner = 'user_someone_else';
    const foreign = await call(get, '/api/terminals/term_0123456789', { method: 'GET', origin: null, params: { id: 'term_0123456789' } });
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe(goneBody);
  });

  it('closes idempotently, refuses a session terminal and a foreign origin, never touches the terminal of another account', async () => {
    const { remove } = await routes();
    const params = { id: 'term_0123456789' };
    expect((await call(remove, '/api/terminals/term_0123456789', { method: 'DELETE', params })).status).toBe(204);
    expect(state.calls.map((c) => c.name)).toEqual(['getTerminal', 'closeTerminal']);
    state.failNext = { name: 'closeTerminal', code: 'NOT_FOUND', message: 'Terminal introuvable ou fermé.' };
    expect((await call(remove, '/api/terminals/term_0123456789', { method: 'DELETE', params })).status).toBe(204);
    state.failNext = { name: 'closeTerminal', code: 'CONFLICT', message: "Ce terminal est celui d'une session Claude : arrêtez la session pour le fermer." };
    expect((await call(remove, '/api/terminals/term_0123456789', { method: 'DELETE', params })).status).toBe(409);
    const calls = state.calls.length;
    expect((await call(remove, '/api/terminals/term_0123456789', { method: 'DELETE', params, origin: 'https://evil.example' })).status).toBe(403);
    expect(state.calls).toHaveLength(calls);

    state.calls = [];
    state.owner = 'user_someone_else';
    expect((await call(remove, '/api/terminals/term_0123456789', { method: 'DELETE', params })).status).toBe(204);
    expect(state.calls.map((c) => c.name)).toEqual(['getTerminal']);
  });
});

describe('/api/terminals/[id]: runner of the server unreachable while checking the terminal', () => {
  it('answers T5 (503 RUNNER_UNAVAILABLE) on GET, DELETE, input and resize, and checks again at the next call', async () => {
    const { get, remove, input, resize } = await routes();
    const down = { name: 'getTerminal', code: 'RUNNER_UNAVAILABLE', message: 'VPS-3 ne répond pas : le runner est injoignable.' };
    const params = { id: 'term_unreachable01' };
    const attempts: Array<() => Promise<Response>> = [
      () => call(get, '/api/terminals/term_unreachable01', { method: 'GET', origin: null, params }),
      () => call(remove, '/api/terminals/term_unreachable01', { method: 'DELETE', params }),
      () => call(input, '/api/terminals/term_unreachable01/input', { body: { data: 'ls\r' }, params }),
      () => call(resize, '/api/terminals/term_unreachable01/resize', { body: { cols: 90, rows: 30 }, params }),
    ];
    for (const attempt of attempts) {
      state.failNext = down;
      const response = await attempt();
      expect(response.status).toBe(503);
      expect((await json<{ error: { code: string; message: string } }>(response)).error).toMatchObject({
        code: 'RUNNER_UNAVAILABLE',
        message: 'VPS-3 ne répond pas : le runner est injoignable.',
      });
    }
    // Nothing was sent to the terminal, and no verdict was cached: the keystroke checks again.
    expect(state.calls.map((c) => c.name)).toEqual(['getTerminal', 'getTerminal', 'getTerminal', 'getTerminal']);
    state.owner = TEST_USER_ID;
    expect((await call(input, '/api/terminals/term_unreachable01/input', { body: { data: 'ls\r' }, params })).status).toBe(204);
    expect(state.calls.map((c) => c.name).slice(-2)).toEqual(['getTerminal', 'terminalInput']);
  });
});

describe('POST /api/terminals/[id]/input and /resize', () => {
  it('forwards keystrokes and sizes, behind the session, the Origin check and the terminal scope', async () => {
    const { input, resize } = await routes();
    const params = { id: 'term_0123456789' };
    expect((await call(input, '/api/terminals/term_0123456789/input', { body: { data: 'ls\r' }, params })).status).toBe(204);
    expect((await call(resize, '/api/terminals/term_0123456789/resize', { body: { cols: 90, rows: 30, clientId: 'tab-1' }, params })).status).toBe(204);
    expect((await call(input, '/api/terminals/term_0123456789/input', { body: { data: 'pwd\r' }, params })).status).toBe(204);
    // The scope is checked once, then reused for the following keystrokes (60 s).
    expect(state.calls).toEqual([
      { name: 'getTerminal', input: { params: { terminalId: 'term_0123456789' } } },
      { name: 'terminalInput', input: { params: { terminalId: 'term_0123456789' }, body: { data: 'ls\r' } } },
      { name: 'terminalResize', input: { params: { terminalId: 'term_0123456789' }, body: { cols: 90, rows: 30, clientId: 'tab-1' } } },
      { name: 'terminalInput', input: { params: { terminalId: 'term_0123456789' }, body: { data: 'pwd\r' } } },
    ]);
    const before = state.calls.length;
    expect((await call(input, '/api/terminals/term_0123456789/input', { body: { data: '' }, params })).status).toBe(422);
    expect((await call(input, '/api/terminals/term_0123456789/input', { body: { data: 'x' }, params, origin: 'https://evil.example' })).status).toBe(403);
    state.signedIn = false;
    expect((await call(input, '/api/terminals/term_0123456789/input', { body: { data: 'x' }, params })).status).toBe(401);
    expect(state.calls).toHaveLength(before);
  });

  it('refuses the keystrokes into a terminal of another account, and forgets a closed one', async () => {
    const { input } = await routes();
    state.owner = 'user_someone_else';
    const params = { id: 'term_0123456789' };
    const foreign = await call(input, '/api/terminals/term_0123456789/input', { body: { data: 'rm -rf /\r' }, params });
    expect(foreign.status).toBe(404);
    expect(state.calls.map((c) => c.name)).toEqual(['getTerminal']);

    state.owner = TEST_USER_ID;
    state.calls = [];
    expect((await call(input, '/api/terminals/term_0123456789/input', { body: { data: 'a' }, params })).status).toBe(204);
    state.failNext = { name: 'terminalInput', code: 'NOT_FOUND', message: 'Terminal introuvable ou fermé.' };
    expect((await call(input, '/api/terminals/term_0123456789/input', { body: { data: 'b' }, params })).status).toBe(404);
    // The verdict was dropped: the next keystroke checks the terminal again.
    await call(input, '/api/terminals/term_0123456789/input', { body: { data: 'c' }, params });
    expect(state.calls.map((c) => c.name)).toEqual(['getTerminal', 'terminalInput', 'terminalInput', 'getTerminal', 'terminalInput']);
  });
});
