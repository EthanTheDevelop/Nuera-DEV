import { describe, expect, it } from 'vitest';
import { AppError } from '@/server/errors';
import { accountRateLimitKey, assertRateLimit, AUTH_RATE_LIMITS, effectiveRule, rateLimiter, SlidingWindowRateLimiter } from './rate-limit';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('SlidingWindowRateLimiter', () => {
  const rule = { limit: 3, windowMs: 60_000 };

  it('allows `limit` hits per window, then refuses with a retry delay', () => {
    const time = clock();
    const limiter = new SlidingWindowRateLimiter({ now: time.now });
    expect(limiter.hit('ip:1', rule)).toMatchObject({ ok: true, remaining: 2 });
    time.advance(10_000);
    expect(limiter.hit('ip:1', rule)).toMatchObject({ ok: true, remaining: 1 });
    time.advance(10_000);
    expect(limiter.hit('ip:1', rule)).toMatchObject({ ok: true, remaining: 0 });
    time.advance(5_000);
    const refused = limiter.hit('ip:1', rule);
    expect(refused.ok).toBe(false);
    // The oldest hit (t0) leaves the window at t0 + 60 s; we are at t0 + 25 s.
    expect(refused.retryAfterMs).toBe(35_000);
  });

  it('slides: an old hit leaving the window frees exactly one slot', () => {
    const time = clock();
    const limiter = new SlidingWindowRateLimiter({ now: time.now });
    limiter.hit('k', rule); // t0
    time.advance(20_000);
    limiter.hit('k', rule); // t0 + 20 s
    limiter.hit('k', rule); // t0 + 20 s
    time.advance(40_001); // t0 + 60.001 s: first hit expired
    expect(limiter.hit('k', rule).ok).toBe(true);
    expect(limiter.hit('k', rule).ok).toBe(false);
  });

  it('does not count refused hits (no lockout extension while hammering)', () => {
    const time = clock();
    const limiter = new SlidingWindowRateLimiter({ now: time.now });
    for (let i = 0; i < 3; i += 1) limiter.hit('k', rule);
    for (let i = 0; i < 10; i += 1) expect(limiter.hit('k', rule).ok).toBe(false);
    time.advance(60_001);
    expect(limiter.hit('k', rule).ok).toBe(true);
  });

  it('keeps keys independent and can reset one key', () => {
    const limiter = new SlidingWindowRateLimiter({ now: clock().now });
    for (let i = 0; i < 3; i += 1) limiter.hit('a', rule);
    expect(limiter.hit('a', rule).ok).toBe(false);
    expect(limiter.hit('b', rule).ok).toBe(true);
    limiter.reset('a');
    expect(limiter.hit('a', rule).ok).toBe(true);
  });

  it('peek does not record a hit', () => {
    const limiter = new SlidingWindowRateLimiter({ now: clock().now });
    expect(limiter.peek('k', rule)).toMatchObject({ ok: true, remaining: 3 });
    expect(limiter.peek('k', rule)).toMatchObject({ ok: true, remaining: 3 });
  });

  it('evicts the least recently used keys beyond maxKeys', () => {
    const limiter = new SlidingWindowRateLimiter({ now: clock().now, maxKeys: 2 });
    limiter.hit('a', rule);
    limiter.hit('b', rule);
    limiter.hit('c', rule);
    expect(limiter.size).toBe(2);
    expect(limiter.peek('a', rule).remaining).toBe(3);
  });
});

describe('assertRateLimit', () => {
  it('throws AppError RATE_LIMITED with a Retry-After once the limit is reached', () => {
    rateLimiter.reset();
    const rule = { limit: 2, windowMs: 60_000 };
    assertRateLimit('test-scope', '203.0.113.7', rule);
    assertRateLimit('test-scope', '203.0.113.7', rule);
    let thrown: unknown;
    try {
      assertRateLimit('test-scope', '203.0.113.7', rule);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect((thrown as AppError).retryAfterSeconds).toBeGreaterThan(0);
    // Another client is not affected.
    expect(() => assertRateLimit('test-scope', '198.51.100.1', rule)).not.toThrow();
  });
});

describe('effectiveRule', () => {
  const rule = { limit: 5, windowMs: 1000 };

  it('applies NUERA_RATE_LIMIT_FACTOR outside production only', () => {
    expect(effectiveRule(rule, { NODE_ENV: 'development', NUERA_RATE_LIMIT_FACTOR: '20' }).limit).toBe(100);
    expect(effectiveRule(rule, { NODE_ENV: 'production', NUERA_RATE_LIMIT_FACTOR: '20' }).limit).toBe(5);
    expect(effectiveRule(rule, { NODE_ENV: 'development' }).limit).toBe(5);
    expect(effectiveRule(rule, { NODE_ENV: 'test', NUERA_RATE_LIMIT_FACTOR: 'abc' }).limit).toBe(5);
  });
});

describe('règles par adresse et par compte (MULTICOMPTE §6)', () => {
  it('sépare deux comptes derrière une même adresse, et garde un filet par adresse', () => {
    rateLimiter.reset();
    const ip = '203.0.113.9';
    expect(accountRateLimitKey(ip, ' Camille@Example.TEST ')).toBe('203.0.113.9:camille@example.test');
    expect(accountRateLimitKey(null, null)).toBe('unknown:unknown');
    for (let i = 0; i < AUTH_RATE_LIMITS.signIn.limit; i += 1) {
      assertRateLimit('auth:sign-in', accountRateLimitKey(ip, 'camille@example.test'), AUTH_RATE_LIMITS.signIn);
    }
    expect(() => assertRateLimit('auth:sign-in', accountRateLimitKey(ip, 'camille@example.test'), AUTH_RATE_LIMITS.signIn)).toThrow(AppError);
    // Another account behind the same address is not locked out…
    expect(() => assertRateLimit('auth:sign-in', accountRateLimitKey(ip, 'ethan@example.test'), AUTH_RATE_LIMITS.signIn)).not.toThrow();
    // …but the net per address caps every e-mail together.
    for (let i = 0; i < AUTH_RATE_LIMITS.signInPerIp.limit; i += 1) assertRateLimit('auth:sign-in-ip', ip, AUTH_RATE_LIMITS.signInPerIp);
    expect(() => assertRateLimit('auth:sign-in-ip', ip, AUTH_RATE_LIMITS.signInPerIp)).toThrow(AppError);
  });

  it('fixe les limites demandées', () => {
    expect(AUTH_RATE_LIMITS.signIn).toEqual({ limit: 10, windowMs: 10 * 60_000 });
    expect(AUTH_RATE_LIMITS.signInPerIp).toEqual({ limit: 50, windowMs: 10 * 60_000 });
    expect(AUTH_RATE_LIMITS.linkToken).toEqual({ limit: 10, windowMs: 15 * 60_000 });
    expect(AUTH_RATE_LIMITS.adminMutation).toEqual({ limit: 30, windowMs: 10 * 60_000 });
  });
});
