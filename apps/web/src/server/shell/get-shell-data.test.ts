import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessions, uptimeDaily } from '@nuera/db/schema';
import type { CurrentUser } from '@/server/auth/session';

/* Test doubles: the database, the runner client, settings and notifications. */
const state = vi.hoisted(() => ({
  activeRows: [] as Array<{ id: string }>,
  beatRows: [] as Array<{ at: Date | null }>,
  metrics: null as unknown,
  claude: null as unknown,
  runnerDown: false,
}));

vi.mock('@/server/db', () => {
  const chain = (rows: unknown[]) => {
    const promise = Promise.resolve(rows);
    const c: Record<string, unknown> = {
      where: () => c,
      orderBy: () => c,
      limit: () => promise,
      // eslint-disable-next-line unicorn/no-thenable -- mimics Drizzle's thenable query builder
      then: promise.then.bind(promise),
    };
    return c;
  };
  return {
    db: {
      select: () => ({
        from: (table: unknown) => chain(table === sessions ? state.activeRows : table === uptimeDaily ? state.beatRows : []),
      }),
    },
  };
});

vi.mock('@/server/settings', () => ({
  getAppSettings: async () => ({ serverName: 'srv-test', serverLocation: 'Lieu test', maxConcurrentSessions: 3 }),
}));

vi.mock('@/server/notifications', () => ({
  listNotifications: async () => ({
    items: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        kind: 'server',
        severity: 'info',
        title: 'Titre',
        body: null,
        href: null,
        read: false,
        createdAt: '2026-11-04T10:00:00.000Z',
      },
    ],
    counts: { unread: 1, total: 1, unreadBySeverity: { info: 1, success: 0, warning: 0, danger: 0 } },
  }),
}));

vi.mock('@/server/runner/client', () => {
  const unavailable = () => Object.assign(new Error('down'), { code: 'RUNNER_UNAVAILABLE' });
  return {
    isRunnerUnavailable: (e: unknown) => (e as { code?: string } | null)?.code === 'RUNNER_UNAVAILABLE',
    runner: {
      systemMetrics: async () => {
        if (state.runnerDown) throw unavailable();
        return state.metrics;
      },
      claudeStatus: async () => {
        if (state.runnerDown) throw unavailable();
        return state.claude;
      },
    },
  };
});

const { getShellData } = await import('./get-shell-data');

const user: CurrentUser = {
  id: 'u1',
  name: 'Prénom Nom',
  email: 'owner@example.test',
  image: null,
  twoFactorEnabled: true,
  authSessionId: 's1',
};

const GB = 1024 ** 3;

beforeEach(() => {
  (globalThis as { __nueraLastRunnerContact?: string }).__nueraLastRunnerContact = undefined;
  state.runnerDown = false;
  state.activeRows = [{ id: 'a' }, { id: 'b' }];
  state.beatRows = [];
  state.metrics = {
    sampledAt: '2026-11-04T10:00:00.000Z',
    hostname: 'h',
    platform: 'linux',
    cpuPercent: 23,
    cpuCount: 4,
    load: [0, 0, 0],
    memory: { usedBytes: 5.1 * GB, totalBytes: 16 * GB, freeBytes: 10.9 * GB, source: 'os' },
    disk: { path: '/srv', usedBytes: 61 * GB, totalBytes: 160 * GB, freeBytes: 99 * GB },
    uptimeSec: 10,
    runnerUptimeSec: 10,
    sessions: { live: 2, max: 3 },
    runs: { live: 0 },
    terminals: { live: 0 },
  };
  state.claude = {
    checkedAt: '2026-11-04T10:00:00.000Z',
    installed: true,
    version: '2.1.0',
    auth: null,
    state: 'connected',
    agents: null,
    error: null,
  };
});

describe('getShellData', () => {
  it('maps settings, live metrics, the CLI state, active sessions and notifications', async () => {
    const data = await getShellData({ ...user });
    expect(data.user).toEqual({ name: 'Prénom Nom', firstName: 'Prénom', twoFactorEnabled: true });
    expect(data.server).toMatchObject({ name: 'srv-test', location: 'Lieu test', availability: 'available', statusUrl: null });
    expect(data.server.metrics).toMatchObject({ cpuPercent: 23, memoryTotalBytes: 16 * GB, diskUsedBytes: 61 * GB });
    expect(data.server.lastContactAt).toBe('2026-11-04T10:00:00.000Z');
    expect(data.claude).toMatchObject({ state: 'connected', version: '2.1.0' });
    expect(data.sessions).toEqual({ activeIds: ['a', 'b'], max: 3 });
    expect(data.notifications.unread).toBe(1);
  });

  it('turns RUNNER_UNAVAILABLE into the T5 state with the last heartbeat as last contact', async () => {
    state.runnerDown = true;
    state.beatRows = [{ at: new Date('2026-11-04T09:57:00.000Z') }];
    const data = await getShellData({ ...user });
    expect(data.server.availability).toBe('unavailable');
    expect(data.server.metrics).toBeNull();
    expect(data.server.lastContactAt).toBe('2026-11-04T09:57:00.000Z');
    expect(data.claude.state).toBe('unknown');
  });

  it('never invents a value when the runner answers with an error other than unavailability', async () => {
    state.metrics = Promise.reject(new Error('UPSTREAM'));
    state.claude = Promise.reject(new Error('UPSTREAM'));
    const data = await getShellData({ ...user });
    expect(data.server.availability).toBe('unknown');
    expect(data.server.metrics).toBeNull();
    expect(data.claude.state).toBe('unknown');
  });

  it('exposes the provider status page only when it is an https URL', async () => {
    vi.stubEnv('NUERA_SERVER_STATUS_URL', 'javascript:alert(1)');
    expect((await getShellData({ ...user })).server.statusUrl).toBeNull();
    vi.stubEnv('NUERA_SERVER_STATUS_URL', 'https://status.example.test/');
    expect((await getShellData({ ...user })).server.statusUrl).toBe('https://status.example.test/');
  });
});
