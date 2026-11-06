import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { proxy } from './proxy';

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
  it('lets the service worker renew a push subscription without a session (GET and POST)', () => {
    expect(passes(proxy(request('/api/push/subscription/renew')))).toBe(true);
    expect(passes(proxy(request('/api/push/subscription/renew', { method: 'POST' })))).toBe(true);
  });

  it('answers 401 to every other API route without a session (only the exact renewal path is public)', async () => {
    for (const path of ['/api/push/subscription', '/api/push/subscription/renew/x', '/api/admin/accounts', '/api/push/subscription/renewal']) {
      const response = proxy(request(path, { method: 'POST' }));
      expect(response.status, path).toBe(401);
      expect(await response.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Connexion requise.' } });
    }
  });

  it('sends pages to /connexion with the requested path, and lets public pages and signed-in requests through', () => {
    const redirected = proxy(request('/administration?onglet=serveurs'));
    expect(redirected.status).toBe(307);
    expect(new URL(redirected.headers.get('location')!).pathname).toBe('/connexion');
    expect(new URL(redirected.headers.get('location')!).searchParams.get('suivant')).toBe('/administration?onglet=serveurs');
    expect(passes(proxy(request('/connexion')))).toBe(true);
    expect(passes(proxy(request('/invitation/abc')))).toBe(true);
    expect(passes(proxy(request('/administration', { cookie: 'nuera.session_token=x' })))).toBe(true);
  });
});

describe('proxy · preview host (« Aperçu »)', () => {
  const PREVIEW = 'apercu.example.test';
  const previewRequest = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    new NextRequest(`https://${PREVIEW}${path}`, { method: init.method ?? 'GET', headers: { host: PREVIEW, ...init.headers } });
  const rewrite = (response: Response) => response.headers.get('x-middleware-rewrite');
  const forwardedPath = (response: Response) => response.headers.get('x-middleware-request-x-nuera-apercu-path');

  beforeEach(() => {
    vi.stubEnv('APP_URL', 'https://dev.example.test');
    vi.stubEnv('PREVIEW_HOST', PREVIEW);
  });

  it('sends every path of the preview host to the relay, application routes and static files included', () => {
    for (const path of ['/', '/projets', '/api/projects', '/api/auth/sign-in', '/_next/static/chunks/main.js', '/logo.png', '/src/main.ts?t=1']) {
      const response = proxy(previewRequest(path, { headers: { 'x-nuera-apercu-path': '/forge' } }));
      expect(new URL(rewrite(response)!).pathname, path).toBe('/api/apercu/proxy');
      expect(forwardedPath(response), path).toBe(path);
      expect(response.headers.get('content-security-policy')).toBe('frame-ancestors https://dev.example.test');
    }
    // No session cookie needed there: the relay checks its own cookie.
    expect(proxy(previewRequest('/api/projects', { method: 'POST' })).status).toBe(200);
  });

  it('keeps /__nuera/ for itself: the entry is rewritten, the rest is 404', () => {
    const entry = proxy(previewRequest('/__nuera/entree?jeton=abc'));
    const target = new URL(rewrite(entry)!);
    expect(target.pathname).toBe('/api/apercu/entree');
    expect(target.searchParams.get('jeton')).toBe('abc');
    expect(entry.headers.get('referrer-policy')).toBe('no-referrer');
    expect(proxy(previewRequest('/__nuera/autre')).status).toBe(404);
  });

  it('never serves the relay routes on the application host, and lets pages frame the preview origin only', async () => {
    const appRequest = (path: string, cookie?: string) => new NextRequest(`https://dev.example.test${path}`, { headers: { host: 'dev.example.test', ...(cookie ? { cookie } : {}) } });
    for (const path of ['/api/apercu/proxy', '/api/apercu/entree?jeton=x']) {
      const response = proxy(appRequest(path, 'nuera.session_token=x'));
      expect(response.status, path).toBe(404);
      expect(rewrite(response)).toBeNull();
    }
    const page = proxy(appRequest('/workspace/x', 'nuera.session_token=x'));
    expect(passes(page)).toBe(true);
    expect(page.headers.get('content-security-policy')).toContain('frame-src https://apercu.example.test');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    vi.stubEnv('PREVIEW_HOST', '');
    expect(proxy(appRequest('/workspace/x', 'nuera.session_token=x')).headers.get('content-security-policy')).toBeNull();
    // A request naming the preview host while the feature is off is an ordinary application request.
    expect(proxy(previewRequest('/projets')).status).toBe(307);
  });
});
