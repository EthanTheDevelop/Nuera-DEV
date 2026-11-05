/**
 * Fake Streamable-HTTP MCP endpoint (tests only): `initialize` (legacy 2025-11-25 handshake with
 * Mcp-Session-Id), `notifications/initialized`, paginated `tools/list`, DELETE of the session.
 * Answers in JSON or as an SSE stream; 401 when the expected bearer token is missing.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeMcpOptions {
  /** Expected `Authorization` header value; null = no auth required. */
  expectedAuthorization: string | null;
  tools: string[];
  mode?: 'json' | 'sse';
  /** Tools per tools/list page. */
  pageSize?: number;
  serverName?: string;
}

export interface FakeMcpState extends FakeMcpOptions {
  methods: string[];
  /** Answer every request with this HTTP status (e.g. 404 = MCP disabled, 503). */
  forceStatus: number | null;
  /** Delay before answering (timeouts). */
  delayMs: number;
  sessions: Set<string>;
  deletes: number;
  receivedHeaders: Array<Record<string, string | string[] | undefined>>;
}

export function createMcpHandler(state: FakeMcpState) {
  return async (req: IncomingMessage, res: ServerResponse, rawBody: string): Promise<void> => {
    state.receivedHeaders.push(req.headers);
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (state.forceStatus) {
      res.writeHead(state.forceStatus, { 'content-type': 'text/html' });
      res.end('<html>error</html>');
      return;
    }
    if (state.expectedAuthorization && req.headers.authorization !== state.expectedAuthorization) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer resource_metadata="https://fake.test/.well-known/oauth-protected-resource", scope="read"',
      });
      res.end(JSON.stringify({ message: 'Unauthenticated.' }));
      return;
    }
    if (req.method === 'DELETE') {
      state.deletes += 1;
      res.writeHead(204);
      res.end();
      return;
    }
    let message: { id?: number | string; method?: string; params?: { cursor?: string } };
    try {
      message = JSON.parse(rawBody) as typeof message;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    state.methods.push(message.method ?? '?');
    if (message.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    let result: unknown;
    const headers: Record<string, string> = {};
    if (message.method === 'initialize') {
      const session = randomUUID();
      state.sessions.add(session);
      headers['mcp-session-id'] = session;
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: state.serverName ?? 'fake-mcp', version: '0.3.0' } };
    } else if (message.method === 'tools/list') {
      const session = req.headers['mcp-session-id'];
      if (typeof session !== 'string' || !state.sessions.has(session)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32600, message: 'Missing session' } }));
        return;
      }
      const size = state.pageSize ?? 50;
      const start = message.params?.cursor ? Number(message.params.cursor) : 0;
      const page = state.tools.slice(start, start + size);
      result = {
        tools: page.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
        ...(start + size < state.tools.length ? { nextCursor: String(start + size) } : {}),
      };
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: 'Method not found' } }));
      return;
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
    if (state.mode === 'sse') {
      // Keep the stream open after the answer, like servers that multiplex notifications.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers });
      res.write(`event: message\ndata: ${payload}\n\n`);
      setTimeout(() => res.end(), 2_000);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', ...headers });
    res.end(payload);
  };
}

export function newMcpState(options: FakeMcpOptions): FakeMcpState {
  return { ...options, methods: [], forceStatus: null, delayMs: 0, sessions: new Set(), deletes: 0, receivedHeaders: [] };
}

export async function startFakeMcp(options: FakeMcpOptions): Promise<{ url: string; state: FakeMcpState; close(): Promise<void> }> {
  const state = newMcpState(options);
  const handler = createMcpHandler(state);
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      handler(req, res, Buffer.concat(chunks).toString('utf8')).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
