import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRunnerEvent, type RunnerEvent } from '@nuera/shared/events';
import { hashToken } from '@nuera/shared/tokens';
import { callRunner, createRunnerClient, proxyRunnerStream, relayGlobalStream, RunnerError, type RunnerEndpoint, type WebChannelEvent } from './client';
import { namespaceEventId, resolveLastEventId } from './stream';

const promoteRunnerToken = vi.hoisted(() => vi.fn<(environmentId: string, presentedHash: string) => Promise<boolean>>(async () => true));
vi.mock('@/server/admin/token-rotation', () => ({ promoteRunnerToken }));

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let handler: Handler = (_req, res) => res.end();
let baseUrl = '';
const seen: Array<{ method?: string; url?: string; authorization?: string; lastEventId?: string; body: string }> = [];

const ENV_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_ENV_ID = '1f2e3d4c-5b6a-4987-8a6b-5c4d3e2f1a0b';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, lastEventId: req.headers['last-event-id'] as string | undefined, body });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

function endpoint(overrides: Partial<RunnerEndpoint> = {}): RunnerEndpoint {
  return {
    environmentId: ENV_ID,
    name: 'VPS-3',
    isDefault: true,
    configSource: 'env',
    status: 'active',
    baseUrl,
    token: 'test-token-0123456789',
    fallbackToken: null,
    problem: null,
    ...overrides,
  };
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('runner client', () => {
  it('sends the bearer token, builds the path and validates the response', async () => {
    handler = (_req, res) => json(res, 200, { terminalId: null, live: false });
    const client = createRunnerClient(async () => endpoint());
    const result = await client.sessionTerminal({ params: { sessionId: '7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f' } });
    expect(result).toEqual({ terminalId: null, live: false });
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/v1/sessions/7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f/terminal', authorization: 'Bearer test-token-0123456789' });
  });

  it('serialises bodies with defaults and query strings', async () => {
    const client = createRunnerClient(async () => endpoint());
    handler = (_req, res) => json(res, 200, { ok: true });
    await client.terminalResize({ params: { terminalId: 'abcdefghijkl' }, body: { cols: 100, rows: 30 } });
    expect(JSON.parse(seen[0]!.body)).toEqual({ cols: 100, rows: 30 });
    handler = (_req, res) => json(res, 200, { commits: [] });
    await client.repoLog({ params: { projectId: '7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f' }, query: { n: 5 } });
    expect(seen[1]!.url).toBe('/v1/repos/7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f/log?n=5');
  });

  it('keeps the runner error code, raw output, machine reason and the server', async () => {
    handler = (_req, res) =>
      json(res, 409, { error: { code: 'CONFLICT', message: 'Divergence.', raw: '$ git merge', untouched: "Rien n'a été modifié.", reason: 'PULL_DIVERGED', data: { ahead: 1 } } });
    const error = await callRunner(endpoint(), 'pullRepo', { params: { projectId: '7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f' }, body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerError);
    expect(error).toMatchObject({ code: 'CONFLICT', status: 409, message: 'Divergence.', raw: '$ git merge', untouched: "Rien n'a été modifié.", reason: 'PULL_DIVERGED', data: { ahead: 1 }, environmentId: ENV_ID });
  });

  it('maps an unreachable runner to RUNNER_UNAVAILABLE with the server name, a broken contract to UPSTREAM', async () => {
    const unreachable = createRunnerClient(async () => endpoint({ baseUrl: 'http://127.0.0.1:9', name: 'VPS-4', environmentId: OTHER_ENV_ID }));
    await expect(unreachable.health()).rejects.toMatchObject({
      code: 'RUNNER_UNAVAILABLE',
      status: 503,
      message: 'VPS-4 ne répond pas : le runner est injoignable.',
      environmentId: OTHER_ENV_ID,
    });
    const legacy = createRunnerClient(async () => endpoint({ baseUrl: 'http://127.0.0.1:9' }));
    await expect(legacy.health()).rejects.toMatchObject({ message: 'VPS-3 ne répond pas : le runner est injoignable.' });

    handler = (_req, res) => json(res, 200, { unexpected: true });
    await expect(createRunnerClient(async () => endpoint()).systemMetrics()).rejects.toMatchObject({ code: 'UPSTREAM' });

    const noToken = createRunnerClient(async () => endpoint({ token: null, problem: "RUNNER_TOKEN n'est pas configuré côté web." }));
    await expect(noToken.systemMetrics()).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE', detail: "RUNNER_TOKEN n'est pas configuré côté web." });
    const noUrl = createRunnerClient(async () => endpoint({ baseUrl: null, problem: "L'adresse du serveur VPS-4 n'est pas configurée." }));
    await expect(noUrl.systemMetrics()).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE' });
    expect(seen).toHaveLength(1);
  });

  it('refuses invalid input before calling the runner', async () => {
    await expect(createRunnerClient(async () => endpoint()).getSession({ params: { sessionId: 'nope' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(seen).toHaveLength(0);
  });

  it('retries once with the token being rotated in when the runner refuses the current one', async () => {
    handler = (req, res) =>
      req.headers.authorization === 'Bearer next-token-0123456789'
        ? json(res, 200, { terminalId: null, live: false })
        : json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Jeton invalide.' } });
    const client = createRunnerClient(async () => endpoint({ fallbackToken: 'next-token-0123456789' }));
    await expect(client.sessionTerminal({ params: { sessionId: '7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f' } })).resolves.toEqual({ terminalId: null, live: false });
    expect(seen.map((r) => r.authorization)).toEqual(['Bearer test-token-0123456789', 'Bearer next-token-0123456789']);
    // The runner accepted the rotated token: it is promoted (MULTICOMPTE §4).
    expect(promoteRunnerToken).toHaveBeenCalledWith(ENV_ID, hashToken('next-token-0123456789'));

    promoteRunnerToken.mockClear();
    seen.length = 0;
    const single = createRunnerClient(async () => endpoint());
    await expect(single.sessionTerminal({ params: { sessionId: '7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f' } })).rejects.toMatchObject({
      code: 'RUNNER_UNAVAILABLE',
      message: 'Le runner a refusé le jeton du serveur web.',
    });
    expect(seen).toHaveLength(1);

    // Both tokens refused: nothing is promoted.
    seen.length = 0;
    const refused = createRunnerClient(async () => endpoint({ fallbackToken: 'other-token-0123456789' }));
    await expect(refused.sessionTerminal({ params: { sessionId: '7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f' } })).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE' });
    expect(seen).toHaveLength(2);
    expect(promoteRunnerToken).not.toHaveBeenCalled();
  });
});

function frames(text: string): Array<{ id: string | null; event: RunnerEvent | null }> {
  return text
    .split('\n\n')
    .filter((frame) => frame.includes('data: '))
    .map((frame) => {
      const lines = frame.split('\n');
      const id = lines.find((l) => l.startsWith('id: '))?.slice(4) ?? null;
      const data = lines.find((l) => l.startsWith('data: '))!.slice(6);
      return { id, event: parseRunnerEvent(data) };
    });
}

const heartbeat = (seq: number) => `id: ${seq}\ndata: {"seq":${seq},"type":"heartbeat","at":"2026-11-05T10:00:00.000Z","data":{}}\n\n`;

describe('event ids', () => {
  it('namespace by server and only forward an id of the same server', () => {
    expect(namespaceEventId(ENV_ID, 42)).toBe(`${ENV_ID}.42`);
    expect(resolveLastEventId(null, ENV_ID)).toEqual({ upstream: null, reset: false });
    expect(resolveLastEventId(`${ENV_ID}.42`, ENV_ID)).toEqual({ upstream: '42', reset: false });
    expect(resolveLastEventId(`${ENV_ID.toUpperCase()}.7`, ENV_ID)).toEqual({ upstream: '7', reset: false });
    expect(resolveLastEventId(`${OTHER_ENV_ID}.42`, ENV_ID)).toEqual({ upstream: null, reset: true });
    expect(resolveLastEventId('42', ENV_ID)).toEqual({ upstream: null, reset: true });
    expect(resolveLastEventId(`${ENV_ID}.42; drop`, ENV_ID)).toEqual({ upstream: null, reset: true });
  });
});

describe('proxyRunnerStream', () => {
  it('relays the SSE frames with namespaced ids and forwards a Last-Event-ID of the same server', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Split inside a frame: the relay must only rewrite complete frames.
      res.write(heartbeat(5).slice(0, 10));
      res.write(heartbeat(5).slice(10));
      res.write(heartbeat(6));
      res.end();
    };
    const request = new Request('http://localhost/api/stream/events', { headers: { 'last-event-id': `${ENV_ID}.4` } });
    const response = await proxyRunnerStream(request, endpoint(), '/v1/events');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const parsed = frames(await response.text());
    expect(parsed.map((f) => f.id)).toEqual([`${ENV_ID}.5`, `${ENV_ID}.6`]);
    expect(parsed.every((f) => f.event?.type === 'heartbeat')).toBe(true);
    expect(seen[0]).toMatchObject({ url: '/v1/events', lastEventId: '4', authorization: 'Bearer test-token-0123456789' });
  });

  it('does not forward an id of another server (or the former format) and emits stream.reset first', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(heartbeat(1));
    };
    for (const lastEventId of [`${OTHER_ENV_ID}.40`, '40']) {
      seen.length = 0;
      const response = await proxyRunnerStream(new Request(`http://localhost/api/stream/sessions/x?lastEventId=${encodeURIComponent(lastEventId)}`), endpoint(), '/v1/sessions/x/stream');
      const parsed = frames(await response.text());
      expect(parsed[0]).toMatchObject({ id: null, event: { type: 'stream.reset', data: { reason: 'replay_unavailable' } } });
      expect(parsed[1]).toMatchObject({ id: `${ENV_ID}.1` });
      expect(seen[0]!.lastEventId).toBeUndefined();
    }
  });

  it('answers a stream.error event naming the server when the runner is unreachable (T5)', async () => {
    const response = await proxyRunnerStream(new Request('http://localhost/api/stream/events'), endpoint({ baseUrl: 'http://127.0.0.1:9', name: 'VPS-4' }), '/v1/events');
    expect(response.status).toBe(200);
    const parsed = frames(await response.text());
    expect(parsed[0]!.event).toMatchObject({ type: 'stream.error', data: { code: 'RUNNER_UNAVAILABLE', message: 'VPS-4 ne répond pas : le runner est injoignable.' } });
  });

  it('retries with the token being rotated in and promotes it once the runner accepts it', async () => {
    promoteRunnerToken.mockClear();
    handler = (req, res) => {
      if (req.headers.authorization !== 'Bearer next-token-0123456789') {
        json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Jeton invalide.' } });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(heartbeat(3));
    };
    const response = await proxyRunnerStream(new Request('http://localhost/api/stream/events'), endpoint({ fallbackToken: 'next-token-0123456789' }), '/v1/events');
    expect(frames(await response.text()).map((f) => f.id)).toEqual([`${ENV_ID}.3`]);
    expect(seen.map((r) => r.authorization)).toEqual(['Bearer test-token-0123456789', 'Bearer next-token-0123456789']);
    expect(promoteRunnerToken).toHaveBeenCalledWith(ENV_ID, hashToken('next-token-0123456789'));
  });

  it('turns a runner 404 into a JSON 404 so EventSource stops retrying', async () => {
    handler = (_req, res) => json(res, 404, { error: { code: 'NOT_FOUND', message: 'Session introuvable.' } });
    const response = await proxyRunnerStream(new Request('http://localhost/api/stream/sessions/x'), endpoint(), '/v1/sessions/x/stream');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: 'Session introuvable.' } });
  });
});

describe('relayGlobalStream', () => {
  it('starts with stream.hello, then relays the server events', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(heartbeat(9));
    };
    const response = await relayGlobalStream(new Request('http://localhost/api/stream/events'), { userId: 'user-a', endpoint: endpoint() });
    const parsed = frames(await response.text());
    expect(parsed[0]).toEqual({ id: null, event: expect.objectContaining({ type: 'stream.hello', seq: 0, data: { userId: 'user-a', environmentId: ENV_ID } }) });
    expect(parsed[1]!.id).toBe(`${ENV_ID}.9`);
  });

  it('keeps hello first even when the runner is unreachable', async () => {
    const response = await relayGlobalStream(new Request('http://localhost/api/stream/events'), { userId: 'user-a', endpoint: endpoint({ baseUrl: 'http://127.0.0.1:9' }) });
    const parsed = frames(await response.text());
    expect(parsed.map((f) => f.event?.type)).toEqual(['stream.hello', 'stream.error', 'heartbeat']);
  });

  it('serves hello, heartbeats and the web channel to an account without a server, until the browser leaves', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const abort = new AbortController();
      let push: ((event: WebChannelEvent) => void) | undefined;
      const unsubscribe = vi.fn<() => void>();
      const response = await relayGlobalStream(new Request('http://localhost/api/stream/events', { signal: abort.signal }), {
        userId: 'user-b',
        endpoint: null,
        webChannel: (listener) => {
          push = listener;
          return unsubscribe;
        },
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const readSome = async () => {
        const { value } = await reader.read();
        text += decoder.decode(value);
      };
      await readSome();
      await readSome();
      push!({ type: 'notification.read', at: new Date().toISOString(), data: { all: true } });
      await readSome();
      vi.advanceTimersByTime(15_000);
      await readSome();
      abort.abort();
      expect(text.startsWith('retry: ')).toBe(true);
      const parsed = frames(text);
      expect(parsed[0]).toMatchObject({ id: null, event: { type: 'stream.hello', data: { userId: 'user-b', environmentId: null } } });
      expect(parsed.some((f) => f.event?.type === 'heartbeat')).toBe(true);
      expect(text).toContain('data: {"seq":0,"type":"notification.read",');
      expect(parsed.every((f) => f.id === null)).toBe(true);
      await reader.read().catch(() => undefined);
      expect(unsubscribe).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
