import { describe, expect, it } from 'vitest';
import { normalizePreviewPath, previewResponseHeaders, readPreviewConfig, sameSiteHosts } from './preview';
import { APP_PERMISSIONS_POLICY } from './security-headers';

describe('preview configuration', () => {
  it('is off, with its reason, without a valid PREVIEW_HOST distinct from the application', () => {
    expect(readPreviewConfig({ APP_URL: 'https://dev.example.test' })).toEqual({ enabled: false, reason: expect.stringContaining('PREVIEW_HOST') });
    expect(readPreviewConfig({ APP_URL: 'https://dev.example.test', PREVIEW_HOST: 'pas un hôte' })).toMatchObject({ enabled: false });
    expect(readPreviewConfig({ APP_URL: 'https://dev.example.test', PREVIEW_HOST: 'DEV.example.test:443' })).toMatchObject({ enabled: false, reason: expect.stringContaining('autre hôte') });
  });

  it('production: same site → SameSite=Lax, Secure, https origin', () => {
    expect(readPreviewConfig({ APP_URL: 'https://nuera-dev.perso.nuera.studio', PREVIEW_HOST: 'https://Nuera-Dev-Apercu.perso.nuera.studio/', NODE_ENV: 'production' })).toEqual({
      enabled: true,
      host: 'nuera-dev-apercu.perso.nuera.studio',
      origin: 'https://nuera-dev-apercu.perso.nuera.studio',
      appOrigin: 'https://nuera-dev.perso.nuera.studio',
      sameSite: 'lax',
      secure: true,
    });
  });

  it('test stack: localhost vs 127.0.0.1 are two sites → SameSite=None (Secure)', () => {
    expect(readPreviewConfig({ APP_URL: 'http://localhost:3610', PREVIEW_HOST: '127.0.0.1:3610' })).toMatchObject({
      enabled: true,
      host: '127.0.0.1:3610',
      origin: 'http://127.0.0.1:3610',
      appOrigin: 'http://localhost:3610',
      sameSite: 'none',
      secure: true,
    });
    expect(sameSiteHosts('a.nuera.studio', 'b.perso.nuera.studio')).toBe(true);
    expect(sameSiteHosts('localhost', '127.0.0.1')).toBe(false);
    expect(sameSiteHosts('a.example.test', 'a.autre.test')).toBe(false);
  });

  it('accepts site paths only', () => {
    expect(normalizePreviewPath('')).toBe('/');
    expect(normalizePreviewPath('devis?id=3')).toBe('/devis?id=3');
    for (const bad of ['//evil.test/', '/a b', '/__nuera/entree', '/a\\b']) expect(normalizePreviewPath(bad), bad).toBeNull();
  });

  it('gives the microphone to the application origin only, never to the preview host', () => {
    expect(APP_PERMISSIONS_POLICY).toContain('microphone=(self)');
    expect(APP_PERMISSIONS_POLICY).toContain('camera=()');
    const config = readPreviewConfig({ APP_URL: 'http://localhost:3610', PREVIEW_HOST: '127.0.0.1:3610' });
    if (!config.enabled) throw new Error('preview expected');
    expect(previewResponseHeaders(config)['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(), payment=()');
  });
});
