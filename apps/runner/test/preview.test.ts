import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })));
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
