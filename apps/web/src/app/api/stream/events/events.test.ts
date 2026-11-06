import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/server/auth/session';
import { publishUserEvent, userEventListenerCount } from '@/server/notifications/user-events';
import { closeTestDb, prepareTestDatabase, resetTables } from '@/server/preferences/test/db';
import { useTestEncryptionKey } from '@/server/tenancy/test/db';
import { startFakeRunner, type FakeRunner } from '@/server/tenancy/test/fake-runner';
import { createTestAccount, type TestAccount } from '@/server/tenancy/test/fixtures';

/*
 * GET /api/stream/events merges the account's own web channel (docs/MULTICOMPTE.md §5) into its
 * global stream, against PostgreSQL (`nuera_w5_settings_events`) and a fake runner kept open: the
 * account receives its notifications (seq 0, no `id:` line), never another account's, also without
 * a server, and the subscription ends with the connection.
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

type Handler = (request: NextRequest, context: { params: Promise<unknown> }) => Promise<Response>;

let runner: FakeRunner;
let a: TestAccount;
let b: TestAccount;

beforeAll(async () => {
  useTestEncryptionKey();
  await prepareTestDatabase('events');
  runner = await startFakeRunner();
});

afterAll(async () => {
  await runner.close();
  await closeTestDb();
});

beforeEach(async () => {
  a = await resetTables();
  b = await createTestAccount({ role: 'member', name: 'Lina Moreau', email: 'lina@example.test', environment: { configSource: 'db', name: 'VPS-4', url: runner.url } });
  runner.requests.length = 0;
  // The server's stream stays open: one heartbeat, then nothing (the web channel interleaves).
  runner.handle((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('id: 7\ndata: {"seq":7,"type":"heartbeat","at":"2026-11-05T10:00:00.000Z","data":{}}\n\n');
  });
});

interface Frame {
  id: string | null;
  type: string;
  seq: number;
  data: Record<string, unknown>;
}

/** Opens the stream as `user`, then reads frames until `until` holds (or 5 s), and closes it. */
async function readStream(user: CurrentUser, during: () => void, until: (frames: Frame[]) => boolean): Promise<Frame[]> {
  state.current = user;
  const { GET } = await import('./route');
  const controller = new AbortController();
  const response = await (GET as Handler)(new NextRequest('http://localhost:3800/api/stream/events', { signal: controller.signal }), { params: Promise.resolve({}) });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: Frame[] = [];
  const deadline = Date.now() + 5_000;
  let triggered = false;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 200))]);
    if (chunk && !chunk.done) buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      const data = raw.split('\n').find((line) => line.startsWith('data: '));
      if (!data) continue;
      const parsed = JSON.parse(data.slice(6)) as Omit<Frame, 'id'>;
      frames.push({ id: raw.split('\n').find((line) => line.startsWith('id: '))?.slice(4) ?? null, ...parsed });
    }
    if (!triggered && frames.some((frame) => frame.type === 'stream.hello')) {
      triggered = true;
      during();
    }
    if (until(frames) || chunk?.done) break;
  }
  controller.abort();
  await reader.cancel().catch(() => undefined);
  return frames;
}

const created = (title: string) => ({
  type: 'notification.created' as const,
  at: '2026-11-05T10:00:01.000Z',
  data: { id: crypto.randomUUID(), kind: 'server', severity: 'info' as const, title, body: null, href: null, projectId: null, sessionId: null },
});

describe('GET /api/stream/events · web channel per account', () => {
  it("merges the account's notifications into its server's stream, never another account's", async () => {
    const frames = await readStream(
      b.user,
      () => {
        publishUserEvent(a.user.id, created('Pour A'));
        publishUserEvent(b.user.id, created('Pour B'));
        publishUserEvent(b.user.id, { type: 'notification.read', at: '2026-11-05T10:00:02.000Z', data: { all: true } });
      },
      (list) => list.some((frame) => frame.type === 'notification.read'),
    );
    expect(frames[0]).toMatchObject({ type: 'stream.hello', id: null, data: { userId: b.user.id, environmentId: b.environment!.id } });
    expect(frames.find((frame) => frame.type === 'heartbeat')).toMatchObject({ id: `${b.environment!.id}.7` });
    const notifications = frames.filter((frame) => frame.type === 'notification.created');
    expect(notifications.map((frame) => [frame.data.title, frame.seq, frame.id])).toEqual([['Pour B', 0, null]]);
    expect(frames.find((frame) => frame.type === 'notification.read')).toMatchObject({ seq: 0, id: null, data: { all: true } });
    expect(runner.requests.map((request) => request.path)).toEqual([`/v1/events?spaceId=${b.space.id}`]);
  });

  it('serves the web channel to an account without a server, without contacting any runner', async () => {
    const c = await createTestAccount({ role: 'member', name: 'Sans Serveur', environment: false });
    const frames = await readStream(
      c.user,
      () => publishUserEvent(c.user.id, created('Pour C')),
      (list) => list.some((frame) => frame.type === 'notification.created'),
    );
    expect(frames[0]).toMatchObject({ type: 'stream.hello', data: { userId: c.user.id, environmentId: null } });
    expect(frames.filter((frame) => frame.type === 'notification.created').map((frame) => frame.data.title)).toEqual(['Pour C']);
    expect(runner.requests).toEqual([]);
  });

  it('keeps the web channel live while the server is out of reach (stream.error, runner.unavailable, stream open)', async () => {
    const d = await createTestAccount({ role: 'member', name: 'Serveur Coupé', email: 'coupe@example.test', environment: { configSource: 'db', name: 'VPS-9', url: 'http://127.0.0.1:9' } });
    const frames = await readStream(
      d.user,
      () => {
        publishUserEvent(a.user.id, created('Pour A'));
        publishUserEvent(d.user.id, created('Pour D'));
      },
      (list) => list.some((frame) => frame.type === 'notification.created'),
    );
    expect(frames.map((frame) => frame.type).slice(0, 3)).toEqual(['stream.hello', 'stream.error', 'runner.unavailable']);
    expect(frames[1]).toMatchObject({ seq: 0, id: null, data: { code: 'RUNNER_UNAVAILABLE', message: 'VPS-9 ne répond pas : le runner est injoignable.' } });
    expect(frames[2]).toMatchObject({ seq: 0, id: null, data: { retryInMs: 10_000 } });
    // Delivered after the outage was announced: the stream did not end with stream.error.
    expect(frames.filter((frame) => frame.type === 'notification.created').map((frame) => [frame.data.title, frame.seq, frame.id])).toEqual([['Pour D', 0, null]]);
    expect(runner.requests).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(userEventListenerCount(d.user.id)).toBe(0);
  });

  it('unsubscribes when the connection ends', async () => {
    await readStream(b.user, () => undefined, (list) => list.some((frame) => frame.type === 'heartbeat'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(userEventListenerCount(b.user.id)).toBe(0);
  });

  it('refuses a signed-out request', async () => {
    state.current = null;
    const { GET } = await import('./route');
    const response = await (GET as Handler)(new NextRequest('http://localhost:3800/api/stream/events'), { params: Promise.resolve({}) });
    expect(response.status).toBe(401);
    expect(a.user.id).not.toBe(b.user.id);
  });
});
