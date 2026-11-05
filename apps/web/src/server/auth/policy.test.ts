import { describe, expect, it } from 'vitest';
import { evaluateSessionPolicy, safeRedirectPath, SESSION_TOUCH_INTERVAL_MS } from './policy';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const policy = { idleHours: 12, maxDays: 30 };
const t0 = new Date('2026-11-01T08:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);

describe("evaluateSessionPolicy — « 12 h d'inactivité, au plus tard 30 jours »", () => {
  it('keeps a recently used session without touching it', () => {
    const verdict = evaluateSessionPolicy({ createdAt: t0, lastActivityAt: t0 }, policy, at(60_000));
    expect(verdict).toMatchObject({ valid: true, shouldTouch: false });
    if (verdict.valid) expect(verdict.expiresAt).toEqual(at(12 * HOUR));
  });

  it('refreshes the activity at most every 5 minutes', () => {
    const before = evaluateSessionPolicy({ createdAt: t0, lastActivityAt: t0 }, policy, at(SESSION_TOUCH_INTERVAL_MS - 1));
    const after = evaluateSessionPolicy({ createdAt: t0, lastActivityAt: t0 }, policy, at(SESSION_TOUCH_INTERVAL_MS));
    expect(before.valid && before.shouldTouch).toBe(false);
    expect(after.valid && after.shouldTouch).toBe(true);
    if (after.valid) expect(after.idleExpiresAt).toEqual(at(SESSION_TOUCH_INTERVAL_MS + 12 * HOUR));
  });

  it('expires after 12 h without activity', () => {
    const lastActivity = at(2 * HOUR);
    expect(evaluateSessionPolicy({ createdAt: t0, lastActivityAt: lastActivity }, policy, at(14 * HOUR - 1)).valid).toBe(true);
    expect(evaluateSessionPolicy({ createdAt: t0, lastActivityAt: lastActivity }, policy, at(14 * HOUR))).toEqual({
      valid: false,
      reason: 'idle',
    });
  });

  it('expires 30 days after creation even when used every hour', () => {
    const verdict = evaluateSessionPolicy({ createdAt: t0, lastActivityAt: at(30 * DAY - HOUR) }, policy, at(30 * DAY));
    expect(verdict).toEqual({ valid: false, reason: 'absolute' });
  });

  it('caps the next expiry at the absolute limit', () => {
    const verdict = evaluateSessionPolicy({ createdAt: t0, lastActivityAt: at(30 * DAY - 2 * HOUR) }, policy, at(30 * DAY - HOUR));
    expect(verdict.valid).toBe(true);
    if (verdict.valid) expect(verdict.expiresAt).toEqual(at(30 * DAY));
  });

  it('follows the configured durations', () => {
    const short = { idleHours: 1, maxDays: 2 };
    expect(evaluateSessionPolicy({ createdAt: t0, lastActivityAt: t0 }, short, at(HOUR)).valid).toBe(false);
    expect(evaluateSessionPolicy({ createdAt: t0, lastActivityAt: at(2 * DAY - 10) }, short, at(2 * DAY))).toEqual({
      valid: false,
      reason: 'absolute',
    });
  });

  it('never lets an activity date older than the creation shorten the session', () => {
    const verdict = evaluateSessionPolicy({ createdAt: t0, lastActivityAt: new Date(t0.getTime() - 20 * HOUR) }, policy, at(HOUR));
    expect(verdict.valid).toBe(true);
  });
});

describe('safeRedirectPath', () => {
  it('keeps same-site absolute paths', () => {
    expect(safeRedirectPath('/projets/42?onglet=git')).toBe('/projets/42?onglet=git');
    expect(safeRedirectPath('/workspace/abc')).toBe('/workspace/abc');
  });

  it('refuses external, protocol-relative and malformed targets', () => {
    for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'projets', '', null, 42]) {
      expect(safeRedirectPath(value)).toBe('/');
    }
    expect(safeRedirectPath('/a\u0000b')).toBe('/');
  });

  it('never redirects back into the auth pages or the API', () => {
    expect(safeRedirectPath('/connexion')).toBe('/');
    expect(safeRedirectPath('/configuration/double-facteur')).toBe('/');
    expect(safeRedirectPath('/deconnexion')).toBe('/');
    expect(safeRedirectPath('/api/health')).toBe('/');
    expect(safeRedirectPath('/connexions-recentes')).toBe('/connexions-recentes');
  });

  it('accepts the GitHub browser-redirect routes only', () => {
    expect(safeRedirectPath('/api/integrations/github/setup?installation_id=1&setup_action=install')).toBe(
      '/api/integrations/github/setup?installation_id=1&setup_action=install',
    );
    expect(safeRedirectPath('/api/integrations/github/callback?code=x&state=y')).toBe('/api/integrations/github/callback?code=x&state=y');
    expect(safeRedirectPath('/api/integrations/github/install')).toBe('/api/integrations/github/install');
    expect(safeRedirectPath('/api/integrations/github')).toBe('/');
    expect(safeRedirectPath('/api/integrations/github/setupx')).toBe('/');
  });
});
