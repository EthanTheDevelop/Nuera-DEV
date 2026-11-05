import { describe, expect, it } from 'vitest';
import { allowedOrigins, checkOrigin, type OriginCheckInput } from './origin';

const base: OriginCheckInput = {
  method: 'POST',
  origin: 'https://dev.nuera.studio',
  referer: null,
  host: 'dev.nuera.studio',
  secFetchSite: null,
  appUrl: 'https://dev.nuera.studio',
  isProduction: true,
};

describe('checkOrigin (CSRF)', () => {
  it('lets safe methods through without any header', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(checkOrigin({ ...base, method, origin: 'https://evil.example' }).ok).toBe(true);
    }
  });

  it("accepts a mutation from APP_URL's origin", () => {
    expect(checkOrigin(base)).toEqual({ ok: true });
    expect(checkOrigin({ ...base, appUrl: 'https://dev.nuera.studio/' }).ok).toBe(true);
  });

  it('refuses another origin, a look-alike or the opaque "null" origin', () => {
    expect(checkOrigin({ ...base, origin: 'https://evil.example' }).ok).toBe(false);
    expect(checkOrigin({ ...base, origin: 'https://dev.nuera.studio.evil.example' }).ok).toBe(false);
    expect(checkOrigin({ ...base, origin: 'http://dev.nuera.studio' }).ok).toBe(false);
    expect(checkOrigin({ ...base, origin: 'null' }).ok).toBe(false);
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(checkOrigin({ ...base, method, origin: 'https://evil.example' }).ok).toBe(false);
    }
  });

  it('without Origin: trusts Sec-Fetch-Site same-origin, refuses cross-site', () => {
    expect(checkOrigin({ ...base, origin: null, secFetchSite: 'same-origin' }).ok).toBe(true);
    expect(checkOrigin({ ...base, origin: null, secFetchSite: 'cross-site' }).ok).toBe(false);
    expect(checkOrigin({ ...base, origin: null, secFetchSite: 'same-site' }).ok).toBe(false);
  });

  it('without Origin nor Sec-Fetch-Site: falls back to the Referer, else refuses', () => {
    expect(checkOrigin({ ...base, origin: null, referer: 'https://dev.nuera.studio/parametres' }).ok).toBe(true);
    expect(checkOrigin({ ...base, origin: null, referer: 'https://evil.example/x' }).ok).toBe(false);
    expect(checkOrigin({ ...base, origin: null }).ok).toBe(false);
  });

  it('in development also accepts the origin derived from Host (127.0.0.1, other port)', () => {
    const dev = { ...base, appUrl: 'http://localhost:3000', isProduction: false, protocol: 'http' as const };
    expect(checkOrigin({ ...dev, origin: 'http://127.0.0.1:3102', host: '127.0.0.1:3102' }).ok).toBe(true);
    expect(checkOrigin({ ...dev, origin: 'http://evil.example', host: '127.0.0.1:3102' }).ok).toBe(false);
  });

  it('in production ignores the Host header', () => {
    expect(allowedOrigins({ appUrl: 'https://dev.nuera.studio', host: 'evil.example', isProduction: true })).toEqual([
      'https://dev.nuera.studio',
    ]);
    expect(checkOrigin({ ...base, origin: 'https://evil.example', host: 'evil.example' }).ok).toBe(false);
  });

  it('refuses everything when APP_URL is missing in production', () => {
    expect(checkOrigin({ ...base, appUrl: undefined }).ok).toBe(false);
  });
});
