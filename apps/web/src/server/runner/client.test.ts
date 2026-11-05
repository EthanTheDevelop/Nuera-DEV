import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRunnerEvent } from '@nuera/shared/events';
import { callRunner, proxyRunnerStream, runner, RunnerError } from './client';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let handler: Handler = (_req, res) => res.end();
let baseUrl = '';
const seen: Array<{ method?: string; url?: string; authorization?: string; lastEventId?: string; body: string }> = [];

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
  vi.stubEnv('RUNNER_URL', baseUrl);
  vi.stubEnv('RUNNER_TOKEN', 'test-token-0123456789');
});

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('runner client', () => {
  it('sends the bearer token, builds the path and validates the response', async () => {
    handler = (_req, res) => json(res, 200, { terminalId: null, live: false });
    const result = await runner.sessionTerminal({ params: { sessionId: '7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f' } });
    expect(result).toEqual({ terminalId: null, live: false });
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/v1/sessions/7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f/terminal', authorization: 'Bearer test-token-0123456789' });
  });

  it('serialises bodies with defaults and query strings', async () => {
    handler = (_req, res) => json(res, 200, { ok: true });
    await runner.terminalResize({ params: { terminalId: 'abcdefghijkl' }, body: { cols: 100, rows: 30 } });
    expect(JSON.parse(seen[0]!.body)).toEqual({ cols: 100, rows: 30 });
    handler = (_req, res) => json(res, 200, { commits: [] });
    await runner.repoLog({ params: { projectId: '7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f' }, query: { n: 5 } });
    expect(seen[1]!.url).toBe('/v1/repos/7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f/log?n=5');
  });

  it('keeps the runner error code, raw output and machine reason', async () => {
    handler = (_req, res) =>
      json(res, 409, { error: { code: 'CONFLICT', message: 'Divergence.', raw: '$ git merge', untouched: "Rien n'a été modifié.", reason: 'PULL_DIVERGED', data: { ahead: 1 } } });
    const error = await callRunner('pullRepo', { params: { projectId: '7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f' }, body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerError);
    expect(error).toMatchObject({ code: 'CONFLICT', status: 409, message: 'Divergence.', raw: '$ git merge', untouched: "Rien n'a été modifié.", reason: 'PULL_DIVERGED', data: { ahead: 1 } });
  });

  it('maps an unreachable runner to RUNNER_UNAVAILABLE and a broken contract to UPSTREAM', async () => {
    vi.stubEnv('RUNNER_URL', 'http://127.0.0.1:9');
    await expect(runner.health()).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE', status: 503 });
    vi.stubEnv('RUNNER_URL', baseUrl);
    handler = (_req, res) => json(res, 200, { unexpected: true });
    await expect(runner.systemMetrics()).rejects.toMatchObject({ code: 'UPSTREAM' });
    vi.stubEnv('RUNNER_TOKEN', '');
    await expect(runner.systemMetrics()).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE' });
  });

  it('refuses invalid input before calling the runner', async () => {
    await expect(runner.getSession({ params: { sessionId: 'nope' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(seen).toHaveLength(0);
  });
});

describe('proxyRunnerStream', () => {
  it('relays the SSE bytes and forwards Last-Event-ID', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('id: 5\ndata: {"seq":5,"type":"heartbeat","at":"2026-11-05T10:00:00.000Z","data":{}}\n\n');
      res.end();
    };
    const request = new Request('http://localhost/api/stream/events', { headers: { 'last-event-id': '4' } });
    const response = await proxyRunnerStream(request, '/v1/events');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const text = await response.text();
    expect(text).toContain('id: 5');
    expect(seen[0]).toMatchObject({ url: '/v1/events', lastEventId: '4', authorization: 'Bearer test-token-0123456789' });
  });

  it('answers a stream.error event when the runner is unreachable (T5)', async () => {
    vi.stubEnv('RUNNER_URL', 'http://127.0.0.1:9');
    const response = await proxyRunnerStream(new Request('http://localhost/api/stream/events'), '/v1/events');
    expect(response.status).toBe(200);
    const text = await response.text();
    const data = text.split('\n').find((l) => l.startsWith('data: '))!.slice(6);
    expect(parseRunnerEvent(data)).toMatchObject({ type: 'stream.error', data: { code: 'RUNNER_UNAVAILABLE' } });
  });

  it('turns a runner 404 into a JSON 404 so EventSource stops retrying', async () => {
    handler = (_req, res) => json(res, 404, { error: { code: 'NOT_FOUND', message: 'Session introuvable.' } });
    const response = await proxyRunnerStream(new Request('http://localhost/api/stream/sessions/x'), '/v1/sessions/x/stream');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: 'Session introuvable.' } });
  });
});
