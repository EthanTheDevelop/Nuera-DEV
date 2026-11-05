import { auditLog, projects, worktrees } from '@nuera/db/schema';
import type { TerminalDto } from '@nuera/shared/runner';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_USER_ID, closeTestDb, prepareTestDatabase, resetTables } from '@/server/integrations/test/db';

/*
 * Route handlers of the terminal lot: POST /api/terminals, GET + DELETE /api/terminals/[id],
 * POST …/input. Real apiRoute (Origin check, Zod, errors), real database (worktree lookup, audit),
 * session and runner doubles.
 */
const state = vi.hoisted(() => ({
  signedIn: true,
  calls: [] as Array<{ name: string; input: unknown }>,
  failNext: null as null | { code: string; message: string; status?: number },
}));

vi.mock('@/server/auth/session', async () => {
  const { AppError } = await import('@/server/errors');
  return {
    requireUserForApi: async () => {
      if (!state.signedIn) throw new AppError('UNAUTHORIZED');
      return { id: 'test-owner', name: 'Owner', email: 'owner@example.test', image: null, twoFactorEnabled: true, authSessionId: 's1' };
    },
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
    if (failure) {
      state.failNext = null;
      throw new original.RunnerError(failure.code as never, failure.message, failure.status ? { status: failure.status } : {});
    }
  };
  return {
    ...original,
    runner: {
      createTerminal: async (input: { body: { kind: TerminalDto['kind']; worktreeId?: string; cols?: number; rows?: number } }) => {
        record('createTerminal', input);
        const { kind, worktreeId } = input.body;
        return dto({ kind, worktreeId: worktreeId ?? null, private: kind !== 'shell', cols: input.body.cols ?? 120, rows: input.body.rows ?? 32 });
      },
      getTerminal: async (input: { params: { terminalId: string } }) => {
        record('getTerminal', input);
        return dto({ id: input.params.terminalId });
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
    },
  };
});

const ORIGIN = 'http://localhost:3202';

beforeAll(async () => {
  await prepareTestDatabase('terminals');
  vi.stubEnv('APP_URL', ORIGIN);
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTables();
  const { rateLimiter } = await import('@/server/security/rate-limit');
  rateLimiter.reset();
  state.signedIn = true;
  state.calls = [];
  state.failNext = null;
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

async function seedWorktree(status: 'active' | 'removed' = 'active') {
  const { db } = await import('@/server/db');
  const [project] = await db
    .insert(projects)
    .values({
      slug: 'nuera-os',
      name: 'Nuera OS',
      githubFullName: 'nuera-studio/nuera-os',
      cloneUrl: 'https://github.com/nuera-studio/nuera-os.git',
      path: '/srv/dev/nuera-os',
      status: 'ready',
    })
    .returning();
  const [worktree] = await db
    .insert(worktrees)
    .values({
      projectId: project!.id,
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

describe('POST /api/terminals', () => {
  it('requires the owner session', async () => {
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

  it('opens a shell only in an existing, non-removed worktree, and audits it', async () => {
    const { create } = await routes();
    const unknown = await call(create, '/api/terminals', { body: { kind: 'shell', worktreeId: crypto.randomUUID() } });
    expect(unknown.status).toBe(404);
    const removed = await seedWorktree('removed');
    const gone = await call(create, '/api/terminals', { body: { kind: 'shell', worktreeId: removed.worktree.id } });
    expect(gone.status).toBe(404);
    expect(state.calls).toEqual([]);

    await resetTables();
    const { worktree, project } = await seedWorktree('active');
    const response = await call(create, '/api/terminals', { body: { kind: 'shell', worktreeId: worktree.id, cols: 100, rows: 30 } });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const { terminal } = await json<{ terminal: TerminalDto }>(response);
    expect(terminal).toMatchObject({ kind: 'shell', worktreeId: worktree.id, cols: 100, rows: 30 });
    expect(state.calls).toEqual([{ name: 'createTerminal', input: { body: { kind: 'shell', worktreeId: worktree.id, cols: 100, rows: 30 } } }]);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: TEST_USER_ID,
      targetType: 'worktree',
      targetId: worktree.id,
      summary: 'terminal ouvert dans le worktree « crm-core » · Nuera OS',
    });
    expect(rows[0]!.metadata).toMatchObject({ kind: 'shell', terminalId: terminal.id, projectId: project.id });
  });

  it('opens the login and /status terminals (private), audited without any terminal content', async () => {
    const { create } = await routes();
    const login = await call(create, '/api/terminals', { body: { kind: 'claude-login' } });
    expect(login.status).toBe(201);
    expect((await json<{ terminal: TerminalDto }>(login)).terminal).toMatchObject({ kind: 'claude-login', private: true });
    const status = await call(create, '/api/terminals', { body: { kind: 'claude-status' } });
    expect(status.status).toBe(201);
    expect(state.calls.map((c) => c.input)).toEqual([{ body: { kind: 'claude-login' } }, { body: { kind: 'claude-status' } }]);
    const summaries = (await auditRows()).map((row) => row.summary).sort();
    expect(summaries).toEqual(['terminal Claude Code ouvert pour /status', 'terminal de connexion à Claude Code ouvert (claude auth login)']);
  });

  it('rate-limits login terminals per owner', async () => {
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

describe('GET / DELETE /api/terminals/[id]', () => {
  it('returns the terminal, validates the id', async () => {
    const { get } = await routes();
    const ok = await call(get, '/api/terminals/term_0123456789', { method: 'GET', origin: null, params: { id: 'term_0123456789' } });
    expect(ok.status).toBe(200);
    expect((await json<{ terminal: TerminalDto }>(ok)).terminal.id).toBe('term_0123456789');
    const bad = await call(get, '/api/terminals/x', { method: 'GET', origin: null, params: { id: '../etc' } });
    expect(bad.status).toBe(422);
    state.failNext = { code: 'NOT_FOUND', message: 'Terminal introuvable ou fermé.' };
    const gone = await call(get, '/api/terminals/term_0123456789', { method: 'GET', origin: null, params: { id: 'term_0123456789' } });
    expect(gone.status).toBe(404);
  });

  it('closes idempotently, refuses a session terminal and a foreign origin', async () => {
    const { remove } = await routes();
    const params = { id: 'term_0123456789' };
    expect((await call(remove, '/api/terminals/term_0123456789', { method: 'DELETE', params })).status).toBe(204);
    state.failNext = { code: 'NOT_FOUND', message: 'Terminal introuvable ou fermé.' };
    expect((await call(remove, '/api/terminals/term_0123456789', { method: 'DELETE', params })).status).toBe(204);
    state.failNext = { code: 'CONFLICT', message: "Ce terminal est celui d'une session Claude : arrêtez la session pour le fermer." };
    expect((await call(remove, '/api/terminals/term_0123456789', { method: 'DELETE', params })).status).toBe(409);
    const calls = state.calls.length;
    expect((await call(remove, '/api/terminals/term_0123456789', { method: 'DELETE', params, origin: 'https://evil.example' })).status).toBe(403);
    expect(state.calls).toHaveLength(calls);
  });
});

describe('POST /api/terminals/[id]/input and /resize', () => {
  it('forwards keystrokes and sizes, behind the session and the Origin check', async () => {
    const { input, resize } = await routes();
    const params = { id: 'term_0123456789' };
    expect((await call(input, '/api/terminals/term_0123456789/input', { body: { data: 'ls\r' }, params })).status).toBe(204);
    expect((await call(resize, '/api/terminals/term_0123456789/resize', { body: { cols: 90, rows: 30, clientId: 'tab-1' }, params })).status).toBe(204);
    expect(state.calls).toEqual([
      { name: 'terminalInput', input: { params: { terminalId: 'term_0123456789' }, body: { data: 'ls\r' } } },
      { name: 'terminalResize', input: { params: { terminalId: 'term_0123456789' }, body: { cols: 90, rows: 30, clientId: 'tab-1' } } },
    ]);
    expect((await call(input, '/api/terminals/term_0123456789/input', { body: { data: '' }, params })).status).toBe(422);
    expect((await call(input, '/api/terminals/term_0123456789/input', { body: { data: 'x' }, params, origin: 'https://evil.example' })).status).toBe(403);
    state.signedIn = false;
    expect((await call(input, '/api/terminals/term_0123456789/input', { body: { data: 'x' }, params })).status).toBe(401);
    expect(state.calls).toHaveLength(2);
  });
});
