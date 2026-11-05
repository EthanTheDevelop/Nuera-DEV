import 'server-only';
import { AppError } from '@/server/errors';

/**
 * In-memory sliding-window rate limiter (exact sliding log), keyed by `scope:identifier`
 * (identifier = client IP, user id, or both). One web instance serves a single owner, so memory
 * is enough; Better Auth has its own limiter for /api/auth/* HTTP calls (not for auth.api calls,
 * which is why server actions use this one).
 *
 *   assertRateLimit('setup-token', ip ?? 'unknown', { limit: 5, windowMs: 15 * 60_000 });
 */

export interface RateLimitRule {
  /** Maximum number of hits inside the window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Hits still allowed in the current window (after this one). */
  remaining: number;
  /** Milliseconds before the next hit can succeed (0 when ok). */
  retryAfterMs: number;
}

export interface RateLimiterOptions {
  now?: () => number;
  /** Upper bound on tracked keys; the least recently used key is evicted beyond it. */
  maxKeys?: number;
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(options: RateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  /** Records a hit and tells whether it is allowed. Refused hits are not recorded. */
  hit(key: string, rule: RateLimitRule): RateLimitResult {
    const result = this.peek(key, rule);
    if (!result.ok) return result;
    const now = this.now();
    const timestamps = this.recent(key, rule, now);
    timestamps.push(now);
    this.hits.delete(key); // re-insert: Map order = least recently used first
    this.hits.set(key, timestamps);
    this.evict();
    return { ok: true, remaining: Math.max(0, rule.limit - timestamps.length), retryAfterMs: 0 };
  }

  /** State of a key without recording a hit. */
  peek(key: string, rule: RateLimitRule): RateLimitResult {
    const now = this.now();
    const timestamps = this.recent(key, rule, now);
    if (timestamps.length < rule.limit) {
      return { ok: true, remaining: rule.limit - timestamps.length, retryAfterMs: 0 };
    }
    const oldestInWindow = timestamps[timestamps.length - rule.limit]!;
    return { ok: false, remaining: 0, retryAfterMs: Math.max(1, oldestInWindow + rule.windowMs - now) };
  }

  /** Forgets one key (e.g. after a successful sign-in) or everything. */
  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }

  get size(): number {
    return this.hits.size;
  }

  private recent(key: string, rule: RateLimitRule, now: number): number[] {
    const timestamps = this.hits.get(key);
    if (!timestamps) return [];
    const fresh = timestamps.filter((t) => t > now - rule.windowMs);
    if (fresh.length === 0) this.hits.delete(key);
    else if (fresh.length !== timestamps.length) this.hits.set(key, fresh);
    return fresh;
  }

  private evict(): void {
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}

const globalForLimiter = globalThis as unknown as { __nueraRateLimiter?: SlidingWindowRateLimiter };

/** Process-wide limiter (survives Next dev HMR). */
export const rateLimiter: SlidingWindowRateLimiter =
  globalForLimiter.__nueraRateLimiter ?? (globalForLimiter.__nueraRateLimiter = new SlidingWindowRateLimiter());

export function rateLimitKey(scope: string, identifier: string | null | undefined): string {
  return `${scope}:${identifier || 'unknown'}`;
}

/**
 * Outside production, NUERA_RATE_LIMIT_FACTOR (e.g. 50 for the Playwright server) multiplies every
 * limit so that repeated local runs from the same address do not lock themselves out.
 * Production always uses the limits as written.
 */
export function effectiveRule(rule: RateLimitRule, env: Record<string, string | undefined> = process.env): RateLimitRule {
  if (env.NODE_ENV === 'production') return rule;
  const factor = Number(env.NUERA_RATE_LIMIT_FACTOR ?? '1');
  return Number.isFinite(factor) && factor > 1 ? { ...rule, limit: Math.floor(rule.limit * factor) } : rule;
}

export function rateLimit(scope: string, identifier: string | null | undefined, rule: RateLimitRule): RateLimitResult {
  return rateLimiter.hit(rateLimitKey(scope, identifier), effectiveRule(rule));
}

/** Throws AppError RATE_LIMITED (with Retry-After) when the limit is exceeded. */
export function assertRateLimit(scope: string, identifier: string | null | undefined, rule: RateLimitRule): void {
  const result = rateLimit(scope, identifier, rule);
  if (!result.ok) {
    const seconds = Math.ceil(result.retryAfterMs / 1000);
    throw new AppError('RATE_LIMITED', {
      message: `Trop de tentatives. Réessayez dans ${formatWait(seconds)}.`,
      retryAfterSeconds: seconds,
    });
  }
}

export function resetRateLimit(scope: string, identifier: string | null | undefined): void {
  rateLimiter.reset(rateLimitKey(scope, identifier));
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, seconds)} s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} min`;
}

/** Shared rules for authentication-related server actions. */
export const AUTH_RATE_LIMITS = {
  /** /configuration: setup token attempts per IP. */
  setupToken: { limit: 5, windowMs: 15 * 60_000 },
  /** Password step of /connexion per IP. */
  signIn: { limit: 10, windowMs: 10 * 60_000 },
  /** TOTP / backup code attempts per IP. */
  secondFactor: { limit: 10, windowMs: 10 * 60_000 },
  /** Password re-entry for sensitive settings (change password, regenerate codes). */
  sensitive: { limit: 10, windowMs: 15 * 60_000 },
} as const satisfies Record<string, RateLimitRule>;
