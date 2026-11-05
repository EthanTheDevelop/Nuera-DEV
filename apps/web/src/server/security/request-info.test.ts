import { describe, expect, it, vi } from 'vitest';
import { displayableIp, getClientCity, getClientIp } from './request-info';

describe('getClientIp', () => {
  it('reads X-Real-IP set by the reverse proxy, then the right-most X-Forwarded-For entry', () => {
    expect(getClientIp(new Headers({ 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(getClientIp(new Headers({ 'x-forwarded-for': '10.0.0.1, 198.51.100.4' }))).toBe('198.51.100.4');
    expect(getClientIp(new Headers({ 'x-real-ip': '::ffff:203.0.113.9' }))).toBe('203.0.113.9');
    expect(getClientIp(new Headers({ 'x-real-ip': '203.0.113.7:5432' }))).toBe('203.0.113.7');
  });

  it('returns null without a trusted header or with garbage', () => {
    expect(getClientIp(new Headers())).toBeNull();
    expect(getClientIp(new Headers({ 'x-real-ip': '<script>' }))).toBeNull();
  });

  it('honours TRUSTED_IP_HEADER', () => {
    vi.stubEnv('TRUSTED_IP_HEADER', 'cf-connecting-ip');
    expect(getClientIp(new Headers({ 'cf-connecting-ip': '192.0.2.10', 'x-real-ip': '203.0.113.7' }))).toBe('192.0.2.10');
  });
});

describe('getClientCity', () => {
  it('reports a city only from the configured trusted header', () => {
    expect(getClientCity(new Headers({ 'cf-ipcity': 'Lyon' }))).toBeNull();
    vi.stubEnv('TRUSTED_CITY_HEADER', 'cf-ipcity');
    expect(getClientCity(new Headers({ 'cf-ipcity': 'Saint-%C3%89tienne' }))).toBe('Saint-Étienne');
    expect(getClientCity(new Headers())).toBeNull();
  });
});

describe('displayableIp', () => {
  it('hides unspecified addresses (Better Auth masks ::1 to all zeros)', () => {
    expect(displayableIp('0000:0000:0000:0000:0000:0000:0000:0000')).toBeNull();
    expect(displayableIp('::')).toBeNull();
    expect(displayableIp('0.0.0.0')).toBeNull();
    expect(displayableIp(null)).toBeNull();
  });

  it('shows IPv4 as is and a /64-masked IPv6 as its prefix', () => {
    expect(displayableIp('203.0.113.7')).toBe('203.0.113.7');
    expect(displayableIp('2a01:0cb0:1234:5678:0000:0000:0000:0000')).toBe('2a01:cb0:1234:5678::/64');
    expect(displayableIp('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8:0:0:0:0:0:1');
  });
});
