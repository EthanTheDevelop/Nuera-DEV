import { randomUUID } from 'node:crypto';
import { environments, notifications, projects, sessions, uptimeDaily } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, prepareTestDatabase, resetTables, TEST_ENVIRONMENT_ID } from '@/server/preferences/test/db';
import { useTestEncryptionKey } from '@/server/tenancy/test/db';
import { createTestAccount, type TestAccount } from '@/server/tenancy/test/fixtures';

/**
 * Shell data per account and per server, against PostgreSQL (`nuera_w5_settings_shell`) with one fake
 * runner client per server: the account sees its own server's live state, its space's active
 * sessions and its own notifications — never another account's — and no server means no runner call
 * and never T5.
 */

const GB = 1024 ** 3;

interface FakeServer {
  down: boolean;
  metrics: unknown;
  claude: unknown;
}

const runners = vi.hoisted(() => ({ byId: new Map<string, FakeServer>(), asked: [] as string[] }));

vi.mock('@/server/runner/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/runner/client')>();
  const { RunnerError } = await import('@/server/runner/errors');
  const read = (id: string, pick: (server: FakeServer) => unknown) => {
    const server = runners.byId.get(id);
    if (!server || server.down) return Promise.reject(new RunnerError('RUNNER_UNAVAILABLE', 'Le serveur ne répond pas : le runner est injoignable.'));
    return Promise.resolve(pick(server));
  };
  return {
    ...actual,
    getRunnerForEnvironment: (id: string) => {
      runners.asked.push(id);
      return {
        systemMetrics: () => read(id, (server) => server.metrics),
        claudeStatus: () => read(id, (server) => server.claude),
      };
    },
  };
});

const { getShellData } = await import('./get-shell-data');

function metrics(cpuPercent: number, sampledAt: string) {
  return {
    sampledAt,
    hostname: 'h',
    platform: 'linux',
    cpuPercent,
    cpuCount: 4,
    load: [0, 0, 0],
    memory: { usedBytes: 5.1 * GB, totalBytes: 16 * GB, freeBytes: 10.9 * GB, source: 'os' },
    disk: { path: '/srv', usedBytes: 61 * GB, totalBytes: 160 * GB, freeBytes: 99 * GB },
    uptimeSec: 10,
    runnerUptimeSec: 10,
    sessions: { live: 0, max: 4 },
    runs: { live: 0 },
    terminals: { live: 0 },
  };
}

const claude = { checkedAt: '2026-11-04T10:00:00.000Z', installed: true, version: '2.1.0', auth: null, state: 'connected', agents: null, error: null };

let a: TestAccount;
let b: TestAccount;

async function db() {
  return (await import('@/server/db')).db;
}

beforeAll(async () => {
  useTestEncryptionKey();
  await prepareTestDatabase('shell');
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  a = await resetTables();
  b = await createTestAccount({ role: 'member', name: 'Lina Moreau', email: 'lina@example.test', environment: { configSource: 'db', name: 'VPS-4', location: 'Roubaix' } });
  (globalThis as { __nueraLastRunnerContacts?: Map<string, string> }).__nueraLastRunnerContacts?.clear();
  runners.asked.length = 0;
  runners.byId.clear();
  runners.byId.set(TEST_ENVIRONMENT_ID, { down: false, metrics: metrics(23, '2026-11-04T10:00:00.000Z'), claude });
  runners.byId.set(b.environment!.id, { down: false, metrics: metrics(71, '2026-11-04T10:01:00.000Z'), claude: { ...claude, state: 'disconnected' } });
});

async function activeSession(account: TestAccount, slug: string) {
  const [project] = await (await db())
    .insert(projects)
    .values({
      spaceId: account.space.id,
      environmentId: account.environment!.id,
      slug,
      name: slug,
      githubFullName: `atelier/${slug}`,
      cloneUrl: 'https://example.test/x.git',
      path: `/srv/dev/${slug}`,
      status: 'ready',
    })
    .returning();
  const id = randomUUID();
  await (await db()).insert(sessions).values({ id, projectId: project!.id, environmentId: account.environment!.id, title: slug, status: 'running' });
  return id;
}

describe('getShellData', () => {
  it("maps the account, its space, its server's live state, its active sessions and its notifications", async () => {
    const sessionA = await activeSession(a, 'chez-a');
    await activeSession(b, 'chez-b');
    await (await db()).insert(notifications).values([
      { userId: a.user.id, spaceId: a.space.id, kind: 'server', severity: 'info', title: 'Pour A' },
      { userId: b.user.id, spaceId: b.space.id, kind: 'server', severity: 'info', title: 'Pour B' },
    ]);
    const data = await getShellData(a.ctx);
    expect(data.user).toEqual({ id: a.user.id, name: 'Camille Laurent', firstName: 'Camille', role: 'owner', twoFactorEnabled: true });
    expect(data.space).toEqual({ id: a.space.id, name: a.space.name });
    expect(data.environment).toEqual({ id: TEST_ENVIRONMENT_ID, name: 'VPS-3', location: null, status: 'active', isDefault: true });
    expect(data.server).toMatchObject({ name: 'VPS-3', availability: 'available', statusUrl: null, lastContactAt: '2026-11-04T10:00:00.000Z' });
    expect(data.server.metrics).toMatchObject({ cpuPercent: 23, memoryTotalBytes: 16 * GB, diskUsedBytes: 61 * GB });
    expect(data.claude).toMatchObject({ state: 'connected', version: '2.1.0' });
    expect(data.sessions).toEqual({ activeIds: [sessionA], max: 4 });
    expect(data.notifications.items.map((item) => item.title)).toEqual(['Pour A']);
    expect(data.notifications.unread).toBe(1);
    expect(runners.asked.every((id) => id === TEST_ENVIRONMENT_ID)).toBe(true);
  });

  it("a member reads its own server only (« VPS-4 »), never the default server's", async () => {
    await activeSession(a, 'chez-a');
    const data = await getShellData(b.ctx);
    expect(data.user).toMatchObject({ id: b.user.id, role: 'member' });
    expect(data.environment).toMatchObject({ id: b.environment!.id, name: 'VPS-4', location: 'Roubaix', isDefault: false });
    expect(data.server).toMatchObject({ name: 'VPS-4', location: 'Roubaix', availability: 'available' });
    expect(data.server.metrics?.cpuPercent).toBe(71);
    expect(data.claude.state).toBe('disconnected');
    expect(data.sessions.activeIds).toEqual([]);
    expect(data.notifications).toEqual({ items: [], unread: 0 });
    expect(runners.asked).toEqual([b.environment!.id]);
  });

  it('without a server: no runner call, environment null, never T5', async () => {
    const c = await createTestAccount({ role: 'member', name: 'Sans Serveur', environment: false });
    const data = await getShellData(c.ctx);
    expect(data.environment).toBeNull();
    expect(data.server).toEqual({ name: '', location: null, statusUrl: null, availability: 'unknown', metrics: null, lastContactAt: null });
    expect(data.claude.state).toBe('unknown');
    expect(data.sessions).toEqual({ activeIds: [], max: null });
    expect(runners.asked).toEqual([]);
  });

  it("turns RUNNER_UNAVAILABLE into T5 with the server's own last heartbeat", async () => {
    runners.byId.get(b.environment!.id)!.down = true;
    await (await db()).insert(uptimeDaily).values([
      { day: '2026-11-04', service: 'runner', lastBeatAt: new Date('2026-11-04T09:59:00.000Z') },
      { day: '2026-11-04', service: `runner:${b.environment!.id}`, lastBeatAt: new Date('2026-11-04T09:57:00.000Z') },
    ]);
    const data = await getShellData(b.ctx);
    expect(data.server.availability).toBe('unavailable');
    expect(data.server.metrics).toBeNull();
    expect(data.server.lastContactAt).toBe('2026-11-04T09:57:00.000Z');
    expect(data.claude.state).toBe('unknown');
  });

  it('remembers the last contact per server', async () => {
    await getShellData(b.ctx);
    runners.byId.get(b.environment!.id)!.down = true;
    expect((await getShellData(b.ctx)).server.lastContactAt).toBe('2026-11-04T10:01:00.000Z');
    // The default server never borrows B's last contact.
    runners.byId.get(TEST_ENVIRONMENT_ID)!.down = true;
    expect((await getShellData(a.ctx)).server.lastContactAt).toBeNull();
  });

  it('exposes the provider status page for the default server only, and only as an https URL', async () => {
    vi.stubEnv('NUERA_SERVER_STATUS_URL', 'javascript:alert(1)');
    expect((await getShellData(a.ctx)).server.statusUrl).toBeNull();
    vi.stubEnv('NUERA_SERVER_STATUS_URL', 'https://status.example.test/');
    expect((await getShellData(a.ctx)).server.statusUrl).toBe('https://status.example.test/');
    expect((await getShellData(b.ctx)).server.statusUrl).toBeNull();
  });

  it('reads the server row afresh (a rename shows at once)', async () => {
    await (await db()).update(environments).set({ name: 'Atelier', maxConcurrentSessions: 2 }).where(eq(environments.id, b.environment!.id));
    const { invalidateSettingsCache } = await import('@/server/settings');
    invalidateSettingsCache();
    const data = await getShellData(b.ctx);
    expect(data.server.name).toBe('Atelier');
    expect(data.environment?.name).toBe('Atelier');
    expect(data.sessions.max).toBe(2);
  });
});
