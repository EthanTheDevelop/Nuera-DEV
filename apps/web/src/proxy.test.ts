import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ calls: [] as Array<{ path: string; cookie: string | undefined; headers: Headers }> }));
vi.mock('@/server/preview/gate', () => ({
  previewGate: async (input: { headers: Headers; cookie: string | undefined }, path: string) => {
    gate.calls.push({ path, cookie: input.cookie, headers: input.headers });
    if (!input.cookie) return { kind: 'response', response: new Response('Aperçu fermé', { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } }) };
    return { kind: 'rewrite', url: `http://runner.test:4100/v1/runs/r/preview${path}`, headers: new Headers({ authorization: 'Bearer nrt_x', 'x-nuera-preview-app-origin': 'https://dev.example.test' }) };
  },
}));

const { proxy } = await import('./proxy');

/** Optimistic gate: public pages and API routes pass without a session cookie, the rest does not. */

const APP = 'http://localhost:3000';

function request(path: string, init: { method?: string; cookie?: string } = {}): NextRequest {
  return new NextRequest(`${APP}${path}`, {
    method: init.method ?? 'GET',
    headers: init.cookie ? { cookie: init.cookie } : {},
  });
}

function passes(response: Response): boolean {
  return response.headers.get('x-middleware-next') === '1';
}

describe('proxy', () => {
  it('lets the service worker renew a push subscription without a session (GET and POST)', async () => {
    expect(passes((await proxy(request('/api/push/subscription/renew'))))).toBe(true);
    expect(passes((await proxy(request('/api/push/subscription/renew', { method: 'POST' }))))).toBe(true);
  });

  it('answers 401 to every other API route without a session (only the exact renewal path is public)', async () => {
    for (const path of ['/api/push/subscription', '/api/push/subscription/renew/x', '/api/admin/accounts', '/api/push/subscription/renewal']) {
      const response = (await proxy(request(path, { method: 'POST' })));
      expect(response.status, path).toBe(401);
      expect(await response.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Connexion requise.' } });
    }
  });

  it('sends pages to /connexion with the requested path, and lets public pages and signed-in requests through', async () => {
    const redirected = (await proxy(request('/administration?onglet=serveurs')));
    expect(redirected.status).toBe(307);
    expect(new URL(redirected.headers.get('location')!).pathname).toBe('/connexion');
    expect(new URL(redirected.headers.get('location')!).searchParams.get('suivant')).toBe('/administration?onglet=serveurs');
    expect(passes((await proxy(request('/connexion'))))).toBe(true);
    expect(passes((await proxy(request('/invitation/abc'))))).toBe(true);
    expect(passes((await proxy(request('/administration', { cookie: 'nuera.session_token=x' }))))).toBe(true);
  });
});

describe('proxy · preview host (« Aperçu »)', () => {
  const PREVIEW = 'apercu.example.test';
  const previewRequest = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    new NextRequest(`https://${PREVIEW}${path}`, { method: init.method ?? 'GET', headers: { host: PREVIEW, ...init.headers } });
  const rewrite = (response: Response) => response.headers.get('x-middleware-rewrite');

  beforeEach(() => {
    vi.stubEnv('APP_URL', 'https://dev.example.test');
    vi.stubEnv('PREVIEW_HOST', PREVIEW);
  });

  it('sends every path of the preview host to the runner (external rewrite), application routes and static files included', async () => {
    for (const path of ['/', '/projets', '/api/projects', '/api/auth/sign-in', '/_next/static/chunks/main.js', '/logo.png', '/src/main.ts?t=1']) {
      const response = await proxy(previewRequest(path, { headers: { cookie: 'nuera_apercu=c; nuera.session_token=s' } }));
      expect(rewrite(response), path).toBe(`http://runner.test:4100/v1/runs/r/preview${path}`);
      expect(response.headers.get('x-middleware-request-authorization'), path).toBe('Bearer nrt_x');
      expect(response.headers.get('content-security-policy')).toBe('frame-ancestors https://dev.example.test');
    }
    expect(gate.calls.at(-1)).toMatchObject({ path: '/src/main.ts?t=1', cookie: 'c' });
    // No session cookie needed there: the gate checks its own cookie, and answers its own page.
    const closed = await proxy(previewRequest('/api/projects', { method: 'POST' }));
    expect(closed.status).toBe(401);
    expect(closed.headers.get('content-security-policy')).toBe('frame-ancestors https://dev.example.test');
    expect(rewrite(closed)).toBeNull();
  });

  it('keeps /__nuera/ for itself: the entry is rewritten, the rest is 404', async () => {
    const entry = (await proxy(previewRequest('/__nuera/entree?jeton=abc')));
    const target = new URL(rewrite(entry)!);
    expect(target.pathname).toBe('/api/apercu/entree');
    expect(target.searchParams.get('jeton')).toBe('abc');
    expect(entry.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await proxy(previewRequest('/__nuera/autre'))).status).toBe(404);
  });

  it('never serves the preview routes on the application host, and lets pages frame the preview origin only', async () => {
    const appRequest = (path: string, cookie?: string) => new NextRequest(`https://dev.example.test${path}`, { headers: { host: 'dev.example.test', ...(cookie ? { cookie } : {}) } });
    for (const path of ['/api/apercu/proxy', '/api/apercu/entree?jeton=x']) {
      const response = (await proxy(appRequest(path, 'nuera.session_token=x')));
      expect(response.status, path).toBe(404);
      expect(rewrite(response)).toBeNull();
    }
    const page = (await proxy(appRequest('/workspace/x', 'nuera.session_token=x')));
    expect(passes(page)).toBe(true);
    expect(page.headers.get('content-security-policy')).toContain('frame-src https://apercu.example.test');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    vi.stubEnv('PREVIEW_HOST', '');
    expect((await proxy(appRequest('/workspace/x', 'nuera.session_token=x'))).headers.get('content-security-policy')).toBeNull();
    // A request naming the preview host while the feature is off is an ordinary application request.
    expect((await proxy(previewRequest('/projets'))).status).toBe(307);
  });
});
