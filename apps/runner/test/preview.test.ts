import { createServer, type IncomingMessage, type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunDto } from '@nuera/shared/runner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downstreamResponseHeaders, hostOnlyCookie, relativeLocation, upstreamRequestHeaders } from '../src/preview/proxy';
import { auth, createBareRemote, dbReady, git, seedProject, startTestRunner, waitFor, type TestEnv } from './helpers';

/** What the tiny dev server received (echoed back as JSON on every path but the special ones). */
interface Echo {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

function startDevServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '/';
      if (url === '/redirect') {
        response.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/cible?x=1` });
        return response.end();
      }
      if (url === '/frame') {
        response.writeHead(200, {
          'content-type': 'text/html',
          'x-frame-options': 'DENY',
          'content-security-policy': "frame-ancestors 'none'",
          'set-cookie': ['a=1; Path=/; Domain=example.test; HttpOnly', 'b=2'],
          'x-nuera-preview': 'forged',
        });
        return response.end('<p>cadre</p>');
      }
      if (url === '/page') {
        const page = '<!doctype html><html lang="fr"><head><title>Devis</title></head><body>é</body></html>';
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(page) });
        return response.end(page);
      }
      if (url === '/stream') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('un;');
        setTimeout(() => response.write('deux;'), 150);
        setTimeout(() => response.end('trois'), 300);
        return;
      }
      const echo: Echo = { method: request.method ?? '', url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(echo));
    });
  });
  // Hot reload socket: answers the handshake, then echoes every byte prefixed with the path asked.
  server.on('upgrade', (request: IncomingMessage, socket: net.Socket) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Origin: ${request.headers.origin ?? ''}\r\n\r\n`);
    socket.on('data', (chunk: Buffer) => socket.write(`${request.url}:${chunk.toString('utf8')}`));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

/** Raw WebSocket handshake to the runner; resolves with the status line and what follows `ping`. */
function upgrade(port: number, target: string, headers: Record<string, string>): Promise<{ head: string; echo: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let data = '';
    let head = '';
    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (!head && data.includes('\r\n\r\n')) {
        head = data.slice(0, data.indexOf('\r\n\r\n'));
        data = data.slice(head.length + 4);
        if (head.startsWith('HTTP/1.1 101')) socket.write('ping');
        else {
          socket.destroy();
          resolve({ head, echo: '' });
        }
      }
      if (head.startsWith('HTTP/1.1 101') && data.includes('ping')) {
        socket.destroy();
        resolve({ head, echo: data });
      }
    });
    socket.on('close', () => resolve({ head, echo: data }));
    const lines = [`GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  });
}

describe('preview relay headers (pure)', () => {
  it('rewrites the request for the dev server', () => {
    const out = upstreamRequestHeaders(
      {
        host: 'nuera-dev-apercu.test',
        authorization: 'Bearer nrt_runner',
        'x-nuera-preview-authorization': 'Basic dXNlcjpwYXNz',
        'x-nuera-preview-origin': 'https://apercu.test',
        origin: 'https://apercu.test',
        referer: 'https://apercu.test/page?a=1',
        cookie: 'nuera_apercu=secret; theme=sombre; __Secure-nuera.session_token=s; nuera.two_factor=t',
        connection: 'keep-alive, x-hop',
        'x-hop': '1',
        'x-forwarded-for': '1.2.3.4',
        'accept-encoding': 'gzip, br',
        'x-nuera-preview-content-length': '12',
        'content-length': '12',
        accept: 'text/html',
      },
      5173,
    );
    expect(out).toEqual({
      host: 'localhost:5173',
      authorization: 'Basic dXNlcjpwYXNz',
      origin: 'http://localhost:5173',
      referer: 'http://localhost:5173/page?a=1',
      cookie: 'theme=sombre',
      'accept-encoding': 'identity',
      'content-length': '12',
      accept: 'text/html',
    });
  });

  it('rewrites Location and cookies of the response', () => {
    expect(relativeLocation('http://localhost:5173/a?b=1#c', 5173)).toBe('/a?b=1#c');
    expect(relativeLocation('http://127.0.0.1:5173', 5173)).toBe('/');
    expect(relativeLocation('http://localhost:9999/a', 5173)).toBe('http://localhost:9999/a');
    expect(relativeLocation('https://github.com/login', 5173)).toBe('https://github.com/login');
    expect(relativeLocation('/deja', 5173)).toBe('/deja');
    expect(hostOnlyCookie('a=1; Path=/; Domain=.nuera.studio; HttpOnly')).toBe('a=1; Path=/; HttpOnly');
    const headers = downstreamResponseHeaders({ 'x-frame-options': 'DENY', 'transfer-encoding': 'chunked', 'content-type': 'text/html', location: 'http://localhost:1/x' }, 1);
    expect(headers).toEqual({ 'content-type': 'text/html', location: '/x', 'x-nuera-preview': 'upstream', 'cache-control': 'no-store' });
  });
});

describe.skipIf(!dbReady)('preview relay (/v1/runs/:runId/preview)', () => {
  let env: TestEnv;
  let projectId: string;
  let dev: { server: Server; port: number };
  let devRun: RunDto;
  let customRun: RunDto;

  const start = async (kind: 'dev' | 'custom', port: number) => {
    const res = await fetch(`${env.apiUrl}/v1/runs`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, kind, command: `node announce.js ${port}` }),
    });
    expect(res.status).toBe(200);
    const run = (await res.json()) as RunDto;
    await waitFor(async () => {
      const r = (await (await fetch(`${env.apiUrl}/v1/runs/${run.id}`, { headers: auth })).json()) as RunDto;
      return r.port === port ? r : null;
    }, { timeoutMs: 120_000, intervalMs: 300, label: 'port détecté' });
    return run;
  };
  const preview = (runId: string, rest: string, init: RequestInit = {}) =>
    fetch(`${env.apiUrl}/v1/runs/${runId}/preview${rest}`, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) }, redirect: 'manual' });

  beforeAll(async () => {
    env = await startTestRunner();
    dev = await startDevServer();
    const remote = createBareRemote(env.dirs.remotes, 'nuera-studio/apercu');
    const projectPath = path.join(env.dirs.projects, 'apercu');
    git(env.dirs.projects, 'clone', remote.bare, projectPath);
    writeFileSync(path.join(projectPath, 'announce.js'), "console.log(`serveur prêt sur http://localhost:${process.argv[2]}/`); setInterval(() => {}, 1000);");
    projectId = (await seedProject(env.db, { fullName: 'nuera-studio/apercu', path: projectPath, slug: 'apercu' })).id;
    devRun = await start('dev', dev.port);
    customRun = await start('custom', dev.port);
  }, 600_000);

  afterAll(async () => {
    dev?.server.close();
    await env?.close();
  }, 120_000);

  it('relays GET with the path and query, Host set to the dev server', async () => {
    const res = await preview(devRun.id, '/src/main.ts?t=1', { headers: { cookie: 'nuera_apercu=x; theme=clair' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-nuera-preview')).toBe('upstream');
    const echo = (await res.json()) as Echo;
    expect(echo).toMatchObject({ method: 'GET', url: '/src/main.ts?t=1' });
    expect(echo.headers.host).toBe(`localhost:${dev.port}`);
    expect(echo.headers.cookie).toBe('theme=clair');
    expect(echo.headers.authorization).toBeUndefined();
  });

  it('relays the root without a trailing path', async () => {
    const echo = (await (await preview(devRun.id, '')).json()) as Echo;
    expect(echo.url).toBe('/');
  });

  it('relays every method with its body', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await preview(devRun.id, '/api/devis', { method, body: JSON.stringify({ method }), headers: { 'content-type': 'application/json' } });
      if (res.status !== 200) throw new Error(`${method} ${res.status} ${JSON.stringify([...res.headers])} ${await res.text()}`);
      const echo = (await res.json()) as Echo;
      expect(echo).toMatchObject({ method, url: '/api/devis', body: JSON.stringify({ method }) });
      expect(echo.headers['content-type']).toBe('application/json');
    }
    const head = await preview(devRun.id, '/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const options = await preview(devRun.id, '/', { method: 'OPTIONS' });
    expect(((await options.json()) as Echo).method).toBe('OPTIONS');
  });

  it('streams the response as it comes', async () => {
    const res = await preview(devRun.id, '/stream');
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('un;');
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe('deux;trois');
  });

  it('strips framing rules, forged markers and cookie domains; Location becomes relative', async () => {
    const frame = await preview(devRun.id, '/frame');
    expect(frame.headers.get('x-frame-options')).toBeNull();
    expect(frame.headers.get('content-security-policy')).toBeNull();
    expect(frame.headers.get('x-nuera-preview')).toBe('upstream');
    expect(frame.headers.getSetCookie()).toEqual(['a=1; Path=/; HttpOnly', 'b=2']);
    const redirect = await preview(devRun.id, '/redirect');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/cible?x=1');
  });

  it('never leaves the run port: protocol-relative and absolute targets are refused', async () => {
    const refused = await fetch(`${env.apiUrl}/v1/runs/${devRun.id}/preview//127.0.0.1:1/`, { headers: auth });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { reason: string } }).error.reason).toBe('PATH_REJECTED');
  });

  it('refuses a run that is not a dev server, an unknown run and a call without the runner token', async () => {
    const custom = await preview(customRun.id, '/');
    expect(custom.status).toBe(409);
    expect(((await custom.json()) as { error: { reason: string } }).error.reason).toBe('PREVIEW_NOT_DEV');
    const unknown = await preview('00000000-0000-4000-8000-000000000000', '/');
    expect(unknown.status).toBe(404);
    const anonymous = await fetch(`${env.apiUrl}/v1/runs/${devRun.id}/preview/`);
    expect(anonymous.status).toBe(401);
  });

  const DIRECT = { 'x-nuera-preview-app-origin': 'https://dev.example.test', 'x-nuera-preview-origin': 'https://apercu.example.test' };

  it('direct mode: an HTML page keeps its type, gets the position script, loses its length and the markers', async () => {
    const res = await preview(devRun.id, '/page', { headers: DIRECT });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('x-nuera-preview')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toBe('/page');
    const html = await res.text();
    expect(html).toMatch(/^<!doctype html><html lang="fr"><head><script data-nuera-apercu>.*"https:\/\/dev\.example\.test".*<\/script><title>Devis<\/title>/);
    expect(html).toContain('<body>é</body>');
    // Not an HTML page: untouched.
    const json = await preview(devRun.id, '/api/x', { headers: DIRECT });
    expect(json.headers.get('content-type')).toBe('application/json');
    expect(((await json.json()) as Echo).url).toBe('/api/x');
  });

  it('direct mode: the runner refusals are the short French page, never JSON', async () => {
    const custom = await preview(customRun.id, '/', { headers: DIRECT });
    expect(custom.status).toBe(409);
    expect(custom.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await custom.text()).toContain('Aperçu indisponible');
    const anonymous = await fetch(`${env.apiUrl}/v1/runs/${devRun.id}/preview/`, { headers: DIRECT });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(anonymous.headers.get('x-middleware-rewrite')).toBe('/');
  });

  it('relays the WebSocket of the dev server (hot reload), with the runner token only', async () => {
    const port = Number(new URL(env.apiUrl).port);
    const target = `/v1/runs/${devRun.id}/preview/_next/hmr?id=1`;
    const ok = await upgrade(port, target, { authorization: auth.authorization, origin: 'https://apercu.example.test', ...DIRECT });
    expect(ok.head).toMatch(/^HTTP\/1\.1 101 /);
    // Origin of the preview host becomes the dev server's own (Next / Vite refuse another one).
    expect(ok.head).toContain(`x-origin: http://localhost:${dev.port}`);
    expect(ok.echo).toBe('/_next/hmr?id=1:ping');
    expect((await upgrade(port, target, {})).head).toMatch(/^HTTP\/1\.1 401 /);
    expect((await upgrade(port, `/v1/runs/${customRun.id}/preview/`, { authorization: auth.authorization })).head).toMatch(/^HTTP\/1\.1 409 /);
    expect((await upgrade(port, '/v1/sessions', { authorization: auth.authorization })).head).toMatch(/^HTTP\/1\.1 404 /);
  });

  it('refuses a stopped dev server, and a port where nothing listens', async () => {
    expect((await fetch(`${env.apiUrl}/v1/runs/${customRun.id}`, { method: 'DELETE', headers: auth })).status).toBe(200);
    expect((await fetch(`${env.apiUrl}/v1/runs/${devRun.id}`, { method: 'DELETE', headers: auth })).status).toBe(200);
    const stopped = await preview(devRun.id, '/');
    expect(stopped.status).toBe(409);
    expect(((await stopped.json()) as { error: { reason: string } }).error.reason).toBe('PREVIEW_NOT_RUNNING');

    const closed = await startDevServer();
    const deadPort = closed.port;
    await new Promise<void>((resolve) => closed.server.close(() => resolve()));
    const orphan = await start('dev', deadPort);
    const unreachable = await preview(orphan.id, '/');
    expect(unreachable.status).toBe(502);
    expect(((await unreachable.json()) as { error: { reason: string } }).error.reason).toBe('PREVIEW_UNREACHABLE');
    await fetch(`${env.apiUrl}/v1/runs/${orphan.id}`, { method: 'DELETE', headers: auth });
  }, 300_000);
});
