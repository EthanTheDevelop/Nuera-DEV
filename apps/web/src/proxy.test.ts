import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
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
