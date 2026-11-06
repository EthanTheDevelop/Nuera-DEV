import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/server/errors';
import type { RunnerEndpoint } from './config';
import { relayGlobalStream, type WebChannelEvent } from './stream';

vi.mock('@/server/admin/token-rotation', () => ({ promoteRunnerToken: async () => true }));

/*
 * Global stream with a web channel while its runner is out of reach (GAP C2a): the relay keeps the
 * browser connection open (web channel, web heartbeats), announces `stream.error` then
 * `runner.unavailable`, tries the runner again by itself and announces `runner.available` before
 * relaying its events again, resumed after the last id relayed.
 */

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let handler: Handler = (_req, res) => res.end();
let baseUrl = '';
const seen: Array<{ url?: string; lastEventId?: string }> = [];

const ENV_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OTHER_ENV_ID = '1f2e3d4c-5b6a-4987-8a6b-5c4d3e2f1a0b';
const DEAD = 'http://127.0.0.1:9';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, lastEventId: req.headers['last-event-id'] as string | undefined });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
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
    configSource: 'db',
    status: 'active',
    baseUrl,
    token: 'test-token-0123456789',
    fallbackToken: null,
    problem: null,
    ...overrides,
  };
}

const sse = (res: http.ServerResponse) => res.writeHead(200, { 'content-type': 'text/event-stream' });
const heartbeat = (seq: number) => `id: ${seq}\ndata: {"seq":${seq},"type":"heartbeat","at":"2026-11-06T10:00:00.000Z","data":{}}\n\n`;

interface Frame {
  id: string | null;
  type: string;
  seq: number;
  data: Record<string, unknown>;
}

/** Reads an SSE response frame by frame; `until` waits (5 s at most) for a condition on all frames read. */
function reader(response: Response) {
  const body = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = '';
  let ended = false;
  const pump = (async () => {
    for (;;) {
      const chunk = await body.read().catch(() => ({ done: true as const, value: undefined }));
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
        const data = raw.split('\n').find((line) => line.startsWith('data: '));
        if (!data) continue;
        frames.push({ id: raw.split('\n').find((line) => line.startsWith('id: '))?.slice(4) ?? null, ...(JSON.parse(data.slice(6)) as Omit<Frame, 'id'>) });
      }
    }
    ended = true;
  })();
  return {
    frames,
    get ended() {
      return ended;
    },
    async until(condition: (frames: Frame[]) => boolean): Promise<void> {
      const deadline = Date.now() + 5_000;
      while (!condition(frames)) {
        if (Date.now() > deadline) throw new Error(`condition non atteinte : ${JSON.stringify(frames.map((f) => f.type))}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async close() {
      await body.cancel().catch(() => undefined);
      await pump;
    },
  };
}

const types = (frames: Frame[]) => frames.map((frame) => frame.type);
const count = (frames: Frame[], type: string) => frames.filter((frame) => frame.type === type).length;

function channel() {
  let push: ((event: WebChannelEvent) => void) | undefined;
  const unsubscribe = vi.fn<() => void>();
  return {
    webChannel: (listener: (event: WebChannelEvent) => void) => {
      push = listener;
      return unsubscribe;
    },
    push: (event: WebChannelEvent) => push!(event),
    unsubscribe,
  };
}

const notification = (title: string): WebChannelEvent => ({
  type: 'notification.created',
  at: '2026-11-06T10:00:01.000Z',
  data: { id: crypto.randomUUID(), kind: 'server', severity: 'info', title, body: null, href: null, projectId: null, sessionId: null },
});

describe('relayGlobalStream · runner out of reach, web channel kept open (C2a)', () => {
  it('keeps the stream open, delivers the web channel, retries the runner and announces its return', async () => {
    let current = endpoint({ baseUrl: DEAD });
    handler = (_req, res) => {
      sse(res);
      res.write(heartbeat(12));
    };
    const web = channel();
    const abort = new AbortController();
    const response = await relayGlobalStream(new Request('http://localhost/api/stream/events', { signal: abort.signal }), {
      userId: 'user-a',
      endpoint: current,
      webChannel: web.webChannel,
      resolveEndpoint: async () => current,
      probeIntervalMs: 60,
    });
    expect(response.status).toBe(200);
    const stream = reader(response);
    try {
      await stream.until((frames) => count(frames, 'runner.unavailable') >= 2);
      expect(types(stream.frames).slice(0, 3)).toEqual(['stream.hello', 'stream.error', 'runner.unavailable']);
      expect(stream.frames[1]).toMatchObject({ seq: 0, id: null, data: { code: 'RUNNER_UNAVAILABLE', message: 'VPS-3 ne répond pas : le runner est injoignable.' } });
      expect(stream.frames[2]).toMatchObject({ seq: 0, id: null, data: { retryInMs: 60 } });
      // One stream.error per outage, then one runner.unavailable per failed attempt.
      expect(count(stream.frames, 'stream.error')).toBe(1);
      expect(stream.ended).toBe(false);

      web.push(notification('Pendant la panne'));
      await stream.until((frames) => frames.some((frame) => frame.type === 'notification.created'));
      expect(stream.frames.find((frame) => frame.type === 'notification.created')).toMatchObject({ seq: 0, id: null, data: { title: 'Pendant la panne' } });

      // The runner answers again (the endpoint is re-read before each attempt).
      current = endpoint();
      await stream.until((frames) => frames.some((frame) => frame.type === 'heartbeat' && frame.id !== null));
      const list = types(stream.frames);
      expect(list.indexOf('runner.available')).toBeGreaterThan(-1);
      expect(list.indexOf('runner.available')).toBe(list.length - 2);
      expect(stream.frames.at(-1)).toMatchObject({ id: `${ENV_ID}.12`, seq: 12 });
      expect(seen.map((request) => request.url)).toEqual(['/v1/events']);
      expect(stream.ended).toBe(false);
    } finally {
      abort.abort();
      await stream.close();
    }
    expect(web.unsubscribe).toHaveBeenCalled();
  });

  it('degrades when the connection drops mid-stream and resumes after the last id relayed', async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      sse(res);
      if (calls === 1) {
        res.write(heartbeat(5), () => setTimeout(() => res.socket?.destroy(), 30));
        return;
      }
      if (calls === 2) {
        res.socket?.destroy();
        return;
      }
      res.write(heartbeat(6));
    };
    const web = channel();
    const abort = new AbortController();
    const response = await relayGlobalStream(new Request('http://localhost/api/stream/events', { signal: abort.signal }), {
      userId: 'user-a',
      endpoint: endpoint(),
      webChannel: web.webChannel,
      probeIntervalMs: 60,
    });
    const stream = reader(response);
    try {
      await stream.until((frames) => frames.some((frame) => frame.id === `${ENV_ID}.6`));
      const list = types(stream.frames);
      expect(list[0]).toBe('stream.hello');
      expect(stream.frames[1]).toMatchObject({ id: `${ENV_ID}.5` });
      expect(stream.frames.find((frame) => frame.type === 'stream.error')).toMatchObject({ data: { code: 'RUNNER_UNAVAILABLE', message: 'Connexion au runner perdue.' } });
      expect(list.indexOf('stream.error')).toBeLessThan(list.indexOf('runner.unavailable'));
      expect(list.indexOf('runner.available')).toBe(list.length - 2);
      // Every attempt resumes after the last event relayed (the runner replays or sends stream.reset).
      expect(seen.map((request) => request.lastEventId)).toEqual([undefined, '5', '5']);
    } finally {
      abort.abort();
      await stream.close();
    }
  });

  it('retries a runner that closed its stream itself before announcing anything', async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      sse(res);
      if (calls === 1) res.end(heartbeat(1));
      else res.write(heartbeat(2));
    };
    const web = channel();
    const abort = new AbortController();
    const response = await relayGlobalStream(new Request('http://localhost/api/stream/events', { signal: abort.signal }), {
      userId: 'user-a',
      endpoint: endpoint(),
      webChannel: web.webChannel,
      probeIntervalMs: 40,
    });
    const stream = reader(response);
    try {
      await stream.until((frames) => frames.some((frame) => frame.id === `${ENV_ID}.2`));
      expect(types(stream.frames)).toEqual(['stream.hello', 'heartbeat', 'heartbeat']);
      expect(seen.map((request) => request.lastEventId)).toEqual([undefined, '1']);
    } finally {
      abort.abort();
      await stream.close();
    }
  });

  it('stops trying once the browser leaves', async () => {
    const web = channel();
    const abort = new AbortController();
    const resolveEndpoint = vi.fn<() => Promise<RunnerEndpoint>>(async () => endpoint({ baseUrl: DEAD }));
    const response = await relayGlobalStream(new Request('http://localhost/api/stream/events', { signal: abort.signal }), {
      userId: 'user-a',
      endpoint: endpoint({ baseUrl: DEAD }),
      webChannel: web.webChannel,
      resolveEndpoint,
      probeIntervalMs: 30,
    });
    const stream = reader(response);
    await stream.until((frames) => count(frames, 'runner.unavailable') >= 2);
    abort.abort();
    await stream.close();
    const attempts = resolveEndpoint.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(resolveEndpoint.mock.calls.length).toBeLessThanOrEqual(attempts + 1);
    expect(web.unsubscribe).toHaveBeenCalled();
  });

  it('ends the stream when the server is replaced, retired or deleted (the browser reads its new context)', async () => {
    for (const next of [
      async () => endpoint({ baseUrl: DEAD, environmentId: OTHER_ENV_ID }),
      async () => endpoint({ baseUrl: DEAD, status: 'retired' }),
      // Suspended: its account was disabled during the outage (the reconnection is refused).
      async () => endpoint({ baseUrl: DEAD, status: 'suspended' }),
      async (): Promise<RunnerEndpoint> => {
        throw new AppError('NOT_FOUND', 'Serveur introuvable.');
      },
    ]) {
      const web = channel();
      const response = await relayGlobalStream(new Request('http://localhost/api/stream/events'), {
        userId: 'user-a',
        endpoint: endpoint({ baseUrl: DEAD }),
        webChannel: web.webChannel,
        resolveEndpoint: next,
        probeIntervalMs: 30,
      });
      const stream = reader(response);
      await stream.until(() => stream.ended);
      expect(types(stream.frames)).toEqual(['stream.hello', 'stream.error', 'runner.unavailable']);
      expect(web.unsubscribe).toHaveBeenCalled();
    }
  });

  it('ends a stream whose outage lasts too long (the browser reconnects through the authentication)', async () => {
    const web = channel();
    const resolveEndpoint = vi.fn<() => Promise<RunnerEndpoint>>(async () => endpoint({ baseUrl: DEAD }));
    const response = await relayGlobalStream(new Request('http://localhost/api/stream/events'), {
      userId: 'user-a',
      endpoint: endpoint({ baseUrl: DEAD }),
      webChannel: web.webChannel,
      resolveEndpoint,
      probeIntervalMs: 30,
      maxDegradedMs: 150,
    });
    const stream = reader(response);
    await stream.until(() => stream.ended);
    const list = types(stream.frames);
    expect(list.slice(0, 3)).toEqual(['stream.hello', 'stream.error', 'runner.unavailable']);
    expect(count(stream.frames, 'stream.error')).toBe(1);
    expect(list.includes('runner.available')).toBe(false);
    expect(web.unsubscribe).toHaveBeenCalled();
    // No attempt after the end.
    const attempts = resolveEndpoint.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(resolveEndpoint.mock.calls.length).toBe(attempts);
  });

  it('counts the outage from its start: a runner back in time resets it', async () => {
    let current = endpoint({ baseUrl: DEAD });
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      sse(res);
      // Up for a while, then the connection drops: a second, separate outage.
      res.write(heartbeat(calls), () => setTimeout(() => res.socket?.destroy(), 200));
    };
    const web = channel();
    const abort = new AbortController();
    const response = await relayGlobalStream(new Request('http://localhost/api/stream/events', { signal: abort.signal }), {
      userId: 'user-a',
      endpoint: current,
      webChannel: web.webChannel,
      resolveEndpoint: async () => current,
      probeIntervalMs: 40,
      maxDegradedMs: 150,
    });
    const stream = reader(response);
    try {
      await stream.until((frames) => count(frames, 'runner.unavailable') >= 1);
      current = endpoint();
      // Back after < 150 ms of outage, up 200 ms, then down again: the stream is still open.
      await stream.until((frames) => count(frames, 'stream.error') >= 2);
      expect(stream.ended).toBe(false);
      expect(count(stream.frames, 'runner.available')).toBeGreaterThanOrEqual(1);
    } finally {
      abort.abort();
      await stream.close();
    }
  });

  it('keeps an endpoint without address in T5 (its problem as message) and answers a runner 4xx as JSON', async () => {
    const web = channel();
    const abort = new AbortController();
    const response = await relayGlobalStream(new Request('http://localhost/api/stream/events', { signal: abort.signal }), {
      userId: 'user-a',
      endpoint: endpoint({ baseUrl: null, problem: "L'adresse du serveur VPS-3 n'est pas configurée." }),
      webChannel: web.webChannel,
      probeIntervalMs: 1_000,
    });
    const stream = reader(response);
    try {
      await stream.until((frames) => frames.some((frame) => frame.type === 'runner.unavailable'));
      expect(stream.frames[1]).toMatchObject({ type: 'stream.error', data: { message: "L'adresse du serveur VPS-3 n'est pas configurée." } });
    } finally {
      abort.abort();
      await stream.close();
    }

    handler = (_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Flux introuvable.' } }));
    };
    const refused = await relayGlobalStream(new Request('http://localhost/api/stream/events'), { userId: 'user-a', endpoint: endpoint(), webChannel: channel().webChannel });
    expect(refused.status).toBe(404);
  });
});
