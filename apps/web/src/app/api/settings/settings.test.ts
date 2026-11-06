import { appSettings, auditLog, spaceSettings } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/server/auth/session';
import { closeTestDb, prepareTestDatabase, resetTables } from '@/server/preferences/test/db';
import { useTestEncryptionKey } from '@/server/tenancy/test/db';
import { createTestAccount, type TestAccount } from '@/server/tenancy/test/fixtures';

/*
 * PATCH /api/settings by scope (docs/MULTICOMPTE.md §8) and GET /api/claude/status per server, against
 * PostgreSQL (`nuera_w5_settings_route`): a member never changes an instance key (403 « Réglage
 * réservé aux administrateurs. », nothing written), each account writes its own space only, and an
 * account without a server gets 409 NO_ENVIRONMENT without any runner call.
 */

const state = vi.hoisted(() => ({ current: null as CurrentUser | null, runnerCalls: [] as string[] }));

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

vi.mock('@/server/runner/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/runner/client')>();
  return {
    ...actual,
    getRunnerForEnvironment: (id: string) => ({
      claudeStatus: async () => {
        state.runnerCalls.push(id);
        return { checkedAt: '2026-11-05T10:00:00.000Z', installed: true, version: '2.1.0', auth: null, state: 'disconnected', agents: null, error: null };
      },
    }),
  };
});

type Handler = (request: NextRequest, context: { params: Promise<unknown> }) => Promise<Response>;
const ORIGIN = 'http://localhost:3800';

async function call(handler: Handler, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, host: 'localhost:3800' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return handler(
    new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }),
    { params: Promise.resolve({}) },
  );
}

let a: TestAccount;
let b: TestAccount;

async function db() {
  return (await import('@/server/db')).db;
}

beforeAll(async () => {
  useTestEncryptionKey();
  await prepareTestDatabase('route');
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  vi.stubEnv('APP_URL', ORIGIN);
  (await import('@/server/security/rate-limit')).rateLimiter.reset();
  a = await resetTables();
  b = await createTestAccount({ role: 'member', name: 'Lina Moreau', email: 'lina@example.test', environment: { configSource: 'db', name: 'VPS-4' } });
  state.current = b.user;
  state.runnerCalls.length = 0;
});

const routes = async () => ({ settings: await import('./route'), claude: (await import('../claude/status/route')).GET as Handler });

describe('PATCH /api/settings', () => {
  it.each([
    ['webSessionIdleHours', 2],
    ['webSessionMaxDays', 3],
    ['invitationTtlHours', 24],
    ['forceBlockBypassPermissions', true],
    ['serverName', 'Autre nom'],
    ['serverLocation', 'Ailleurs'],
  ])('refuses %s to a member: 403, nothing written, nothing audited', async (key, value) => {
    const { settings } = await routes();
    const instance = await (await db()).select().from(appSettings);
    const response = await call(settings.PATCH as Handler, '/api/settings', { method: 'PATCH', body: { [key]: value } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN', message: 'Réglage réservé aux administrateurs.' } });
    expect(await (await db()).select().from(appSettings)).toEqual(instance);
    expect(await (await db()).select().from(auditLog)).toEqual([]);
  });

  it("writes a member's own space and server, and answers the values with a result per key", async () => {
    const { settings } = await routes();
    const response = await call(settings.PATCH as Handler, '/api/settings', { method: 'PATCH', body: { defaultPermissionMode: 'acceptEdits', maxConcurrentSessions: 3 } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      defaultPermissionMode: 'acceptEdits',
      maxConcurrentSessions: 3,
      serverName: 'VPS-4',
      results: { defaultPermissionMode: { status: 'updated' }, maxConcurrentSessions: { status: 'updated' } },
    });
    const [ofA] = await (await db()).select().from(spaceSettings).where(eq(spaceSettings.spaceId, a.space.id));
    expect(ofA!.defaultPermissionMode).toBe('manual');
  });

  it('lets the owner change an instance key', async () => {
    state.current = a.user;
    const { settings } = await routes();
    const response = await call(settings.PATCH as Handler, '/api/settings', { method: 'PATCH', body: { webSessionIdleHours: 8 } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ webSessionIdleHours: 8, results: { webSessionIdleHours: { status: 'updated' } } });
  });

  it('validates the body (422) and refuses a foreign origin (403) before writing', async () => {
    const { settings } = await routes();
    expect((await call(settings.PATCH as Handler, '/api/settings', { method: 'PATCH', body: {} })).status).toBe(422);
    expect((await call(settings.PATCH as Handler, '/api/settings', { method: 'PATCH', body: { maxConcurrentSessions: 0 } })).status).toBe(422);
    const foreign = await (settings.PATCH as Handler)(
      new NextRequest(`${ORIGIN}/api/settings`, {
        method: 'PATCH',
        headers: { origin: 'https://evil.example', host: 'localhost:3800', 'content-type': 'application/json' },
        body: JSON.stringify({ defaultPermissionMode: 'plan' }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(foreign.status).toBe(403);
    const [ofB] = await (await db()).select().from(spaceSettings).where(eq(spaceSettings.spaceId, b.space.id));
    expect(ofB!.defaultPermissionMode).toBe('manual');
  });

  it('GET shows what the account may change', async () => {
    const { settings } = await routes();
    const body = (await (await call(settings.GET as Handler, '/api/settings')).json()) as { editable: Record<string, boolean>; serverName: string };
    expect(body.serverName).toBe('VPS-4');
    expect(body.editable).toMatchObject({ webSessionIdleHours: false, serverName: false, maxConcurrentSessions: true, theme: true });
  });
});

describe('GET /api/claude/status', () => {
  it("asks the runner of the account's own server", async () => {
    const { claude } = await routes();
    const response = await call(claude, '/api/claude/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'disconnected', version: '2.1.0' });
    expect(state.runnerCalls).toEqual([b.environment!.id]);
  });

  it('answers 409 NO_ENVIRONMENT without a server, without any runner call', async () => {
    const c = await createTestAccount({ role: 'member', name: 'Sans Serveur', environment: false });
    state.current = c.user;
    const { claude } = await routes();
    const response = await call(claude, '/api/claude/status?refresh=1');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'CONFLICT', reason: 'NO_ENVIRONMENT', message: 'Aucun serveur ne vous est encore attribué : un administrateur doit vous en attribuer un.' },
    });
    expect(state.runnerCalls).toEqual([]);
  });
});
