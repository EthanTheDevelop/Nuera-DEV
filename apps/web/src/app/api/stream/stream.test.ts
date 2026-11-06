import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/server/auth/session';
import { closeWebTestDb, prepareTenancyDatabase, useTestEncryptionKey } from '@/server/tenancy/test/db';
import { startFakeRunner, terminalDto, type FakeRunner } from '@/server/tenancy/test/fake-runner';
import { createTestAccount, createTestResources, truncateTenancy, UNREACHABLE_RUNNER_URL, type TestAccount, type TestResources } from '@/server/tenancy/test/fixtures';

/*
 * SSE relays: the scope is checked BEFORE the runner is contacted (an id of another space gets the
 * « unknown » 404 and no runner request), the stream comes from the server holding the resource,
 * event ids are namespaced by server, and the global stream opens with stream.hello.
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

const TOKEN = 'runner-token-for-tests-0123456789abcdef';
let runnerA: FakeRunner;
let runnerB: FakeRunner;
let a: TestAccount;
let b: TestAccount;
let resA: TestResources;
let resB: TestResources;

beforeAll(async () => {
  await prepareTenancyDatabase('stream');
  useTestEncryptionKey();
  runnerA = await startFakeRunner();
  runnerB = await startFakeRunner();
});

afterAll(async () => {
  await runnerA.close();
  await runnerB.close();
  await closeWebTestDb();
});

const sse = (seq: number, type = 'heartbeat') => `id: ${seq}\ndata: {"seq":${seq},"type":"${type}","at":"2026-11-05T10:00:00.000Z","data":{}}\n\n`;

beforeEach(async () => {
  vi.stubEnv('RUNNER_URL', runnerA.url);
  vi.stubEnv('RUNNER_TOKEN', TOKEN);
  vi.stubEnv('APP_URL', 'http://localhost:3104');
  await truncateTenancy();
  a = await createTestAccount({ role: 'owner', name: 'Ethan Martin' });
  b = await createTestAccount({ role: 'member', name: 'Camille Laurent', environment: { url: runnerB.url, name: 'VPS-4' } });
  resA = await createTestResources(a, 'nuera-os');
  resB = await createTestResources(b, 'nuera-os');
  for (const runner of [runnerA, runnerB]) {
    runner.requests.length = 0;
    runner.handle((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(3));
    });
  }
  state.current = b.user;
});

type Handler = (request: NextRequest, context: { params: Promise<unknown> }) => Promise<Response>;

async function open(handler: Handler, path: string, params: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return handler(new NextRequest(`http://localhost:3104${path}`, { headers }), { params: Promise.resolve(params) });
}

function frames(text: string): Array<{ id: string | null; type: string; data: unknown }> {
  return text
    .split('\n\n')
    .filter((frame) => frame.includes('data: '))
    .map((frame) => {
      const lines = frame.split('\n');
      const parsed = JSON.parse(lines.find((l) => l.startsWith('data: '))!.slice(6)) as { type: string; data: unknown };
      return { id: lines.find((l) => l.startsWith('id: '))?.slice(4) ?? null, type: parsed.type, data: parsed.data };
    });
}

/**
 * The global stream stays open (the relay keeps the web channel and reconnects to the runner by
 * itself): read its first `count` frames, then leave as a browser would.
 */
async function readGlobal(handler: Handler, count: number): Promise<string> {
  const abort = new AbortController();
  const response = await handler(new NextRequest('http://localhost:3104/api/stream/events', { signal: abort.signal }), { params: Promise.resolve({}) });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (frames(text).length < count) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    abort.abort();
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

const relays = async () => ({
  sessions: { handler: (await import('./sessions/[id]/route')).GET as Handler, key: 'sessionId' as const, path: (id: string) => `/v1/sessions/${id}/stream`, message: 'Session introuvable.' },
  runs: { handler: (await import('./runs/[id]/route')).GET as Handler, key: 'runId' as const, path: (id: string) => `/v1/runs/${id}/stream`, message: 'Lancement introuvable.' },
  operations: { handler: (await import('./operations/[id]/route')).GET as Handler, key: 'operationId' as const, path: (id: string) => `/v1/operations/${id}/stream`, message: 'Opération introuvable.' },
});

describe('resource relays', () => {
  it('check the scope first: an id of another space gets the « unknown » 404 and no runner request', async () => {
    for (const [name, relay] of Object.entries(await relays())) {
      const unknown = await open(relay.handler, `/api/stream/${name}/x`, { id: crypto.randomUUID() });
      expect(unknown.status, name).toBe(404);
      const unknownBody = await unknown.json();
      expect(unknownBody).toEqual({ error: { code: 'NOT_FOUND', message: relay.message } });

      const foreign = await open(relay.handler, `/api/stream/${name}/x`, { id: resA[relay.key] });
      expect(foreign.status, name).toBe(404);
      expect(await foreign.json()).toEqual(unknownBody);
    }
    expect(runnerA.requests).toHaveLength(0);
    expect(runnerB.requests).toHaveLength(0);
  });

  it('relay from the server holding the resource, ids namespaced by that server', async () => {
    for (const [name, relay] of Object.entries(await relays())) {
      runnerB.requests.length = 0;
      const response = await open(relay.handler, `/api/stream/${name}/x`, { id: resB[relay.key] });
      expect(response.status, name).toBe(200);
      expect(frames(await response.text())).toEqual([{ id: `${b.environment!.id}.3`, type: 'heartbeat', data: {} }]);
      expect(runnerB.requests).toMatchObject([{ path: relay.path(resB[relay.key]), authorization: `Bearer ${b.token}` }]);
    }
    expect(runnerA.requests).toHaveLength(0);
  });

  it('forward a Last-Event-ID of the same server only; another one resets the stream', async () => {
    const { sessions } = await relays();
    await (await open(sessions.handler, '/api/stream/sessions/x', { id: resB.sessionId }, { 'last-event-id': `${b.environment!.id}.2` })).text();
    expect(runnerB.requests[0]!.lastEventId).toBe('2');

    runnerB.requests.length = 0;
    const reset = await open(sessions.handler, '/api/stream/sessions/x', { id: resB.sessionId }, { 'last-event-id': `${a.environment!.id}.2` });
    const parsed = frames(await reset.text());
    expect(parsed[0]).toEqual({ id: null, type: 'stream.reset', data: { reason: 'replay_unavailable' } });
    expect(runnerB.requests[0]!.lastEventId).toBeNull();
  });

  it('refuse a signed-out request before anything else', async () => {
    state.current = null;
    const { sessions } = await relays();
    expect((await open(sessions.handler, '/api/stream/sessions/x', { id: resB.sessionId })).status).toBe(401);
    expect(runnerB.requests).toHaveLength(0);
  });
});

describe('terminal relay', () => {
  const TERMINAL = 'term_0123456789ab';

  it("relays the account's terminal from its server, refuses another account's like an unknown one", async () => {
    const handler = (await import('./terminals/[id]/route')).GET as Handler;
    runnerB.handle((req, res) => {
      if (req.url === `/v1/terminals/${TERMINAL}`) return runnerB.json(res, 200, terminalDto({ id: TERMINAL, ownerUserId: b.user.id, worktreeId: resB.worktreeId }));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"seq":0,"type":"heartbeat","at":"2026-11-05T10:00:00.000Z","data":{}}\n\n');
    });
    const own = await open(handler, `/api/stream/terminals/${TERMINAL}`, { id: TERMINAL });
    expect(own.status).toBe(200);
    expect(frames(await own.text())).toEqual([{ id: null, type: 'heartbeat', data: {} }]);
    expect(runnerB.requests.map((r) => r.path)).toEqual([`/v1/terminals/${TERMINAL}`, `/v1/terminals/${TERMINAL}/stream`]);

    runnerB.requests.length = 0;
    runnerB.handle((_req, res) => runnerB.json(res, 404, { error: { code: 'NOT_FOUND', message: 'Terminal introuvable ou fermé.' } }));
    const unknown = await open(handler, `/api/stream/terminals/${TERMINAL}`, { id: TERMINAL });
    const unknownBody = { status: unknown.status, body: await unknown.json() };
    expect(unknownBody).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Terminal introuvable ou fermé.' } } });

    runnerB.handle((_req, res) => runnerB.json(res, 200, terminalDto({ id: TERMINAL, ownerUserId: a.user.id })));
    const foreign = await open(handler, `/api/stream/terminals/${TERMINAL}`, { id: TERMINAL });
    expect({ status: foreign.status, body: await foreign.json() }).toEqual(unknownBody);
    // Never the stream of a refused terminal.
    expect(runnerB.requests.every((r) => !r.path.endsWith('/stream'))).toBe(true);
    expect(runnerA.requests).toHaveLength(0);
  });

  it('answers T5 as a stream (stream.error naming the server) when the runner cannot be reached for the check', async () => {
    const handler = (await import('./terminals/[id]/route')).GET as Handler;
    const away = await createTestAccount({ role: 'member', environment: { name: 'VPS-7', url: UNREACHABLE_RUNNER_URL } });
    state.current = away.user;
    const response = await open(handler, `/api/stream/terminals/${TERMINAL}`, { id: TERMINAL });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const parsed = frames(await response.text());
    expect(parsed[0]).toEqual({
      id: null,
      type: 'stream.error',
      data: { code: 'RUNNER_UNAVAILABLE', message: 'VPS-7 ne répond pas : le runner est injoignable.' },
    });
  });
});

describe('global stream', () => {
  it('opens with stream.hello for the account and its server, then the server events', async () => {
    const handler = (await import('./events/route')).GET as Handler;
    const parsed = frames(await readGlobal(handler, 2));
    expect(parsed[0]).toEqual({ id: null, type: 'stream.hello', data: { userId: b.user.id, environmentId: b.environment!.id } });
    expect(parsed[1]).toEqual({ id: `${b.environment!.id}.3`, type: 'heartbeat', data: {} });
    // The account's own Claude status only (lot P1).
    expect(runnerB.requests).toMatchObject([{ path: `/v1/events?spaceId=${b.space.id}` }]);
    expect(runnerA.requests).toHaveLength(0);

    state.current = a.user;
    const forA = frames(await readGlobal(handler, 2));
    expect(forA[0]).toMatchObject({ type: 'stream.hello', data: { userId: a.user.id, environmentId: a.environment!.id } });
    expect(runnerA.requests).toMatchObject([{ path: expect.stringMatching(/^\/v1\/events\?spaceId=/), authorization: `Bearer ${TOKEN}` }]);
  });

  it('serves hello to an account without a server, without contacting any runner', async () => {
    const lonely = await createTestAccount({ environment: false });
    state.current = lonely.user;
    const handler = (await import('./events/route')).GET as Handler;
    const abort = new AbortController();
    const response = await handler(new NextRequest('http://localhost:3104/api/stream/events', { signal: abort.signal }), { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('stream.hello')) text += decoder.decode((await reader.read()).value);
    abort.abort();
    expect(frames(text)[0]).toEqual({ id: null, type: 'stream.hello', data: { userId: lonely.user.id, environmentId: null } });
    expect(runnerA.requests).toHaveLength(0);
    expect(runnerB.requests).toHaveLength(0);
  });
});
