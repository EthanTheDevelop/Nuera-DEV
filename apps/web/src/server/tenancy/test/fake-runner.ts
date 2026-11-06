/**
 * Test-only fake runner: a local HTTP server that records every request (method, path,
 * Authorization, Last-Event-ID, body) and answers with a configurable handler.
 *
 *   const runner = await startFakeRunner();
 *   runner.handle((req, res) => runner.json(res, 200, { ok: true }));
 *   … createTestEnvironment({ spaceId, url: runner.url }) …
 *   expect(runner.requests).toHaveLength(0);
 *   await runner.close();
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRunnerRequest {
  method: string;
  path: string;
  authorization: string | null;
  lastEventId: string | null;
  body: string;
}

export type FakeRunnerHandler = (req: http.IncomingMessage, res: http.ServerResponse, recorded: FakeRunnerRequest) => void;

export interface FakeRunner {
  url: string;
  requests: FakeRunnerRequest[];
  handle: (handler: FakeRunnerHandler) => void;
  json: (res: http.ServerResponse, status: number, body: unknown) => void;
  close: () => Promise<void>;
}

export async function startFakeRunner(): Promise<FakeRunner> {
  const requests: FakeRunnerRequest[] = [];
  let handler: FakeRunnerHandler = (_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route inconnue.' } }));
  };
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const recorded: FakeRunnerRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        authorization: req.headers.authorization ?? null,
        lastEventId: (req.headers['last-event-id'] as string | undefined) ?? null,
        body,
      };
      requests.push(recorded);
      handler(req, res, recorded);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    handle: (next) => {
      handler = next;
    },
    json: (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A `TerminalDto` as the runner returns it. */
export function terminalDto(input: { id: string; ownerUserId?: string | null; worktreeId?: string | null; sessionId?: string | null; kind?: string }) {
  const now = new Date().toISOString();
  return {
    id: input.id,
    kind: input.kind ?? 'shell',
    title: 'Terminal',
    cwd: null,
    worktreeId: input.worktreeId ?? null,
    sessionId: input.sessionId ?? null,
    cols: 120,
    rows: 32,
    alive: true,
    exitCode: null,
    private: false,
    subscribers: 0,
    createdAt: now,
    lastActivityAt: now,
    ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
  };
}
