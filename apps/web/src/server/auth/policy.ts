/**
 * Web-session policy (pure functions, unit-tested).
 *
 * « Un accès expire après 12 h d'inactivité, et au plus tard après 30 jours. »
 *   - absolute expiry: createdAt + app_settings.webSessionMaxDays
 *   - idle expiry:     last activity (session.updatedAt) + app_settings.webSessionIdleHours
 *   - last activity is refreshed at most every SESSION_TOUCH_INTERVAL_MS (5 min) to limit writes.
 */

export const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000;
/** Upper bound accepted by the settings (webSessionMaxDays ≤ 90): used as the cookie lifetime. */
export const SESSION_HARD_CEILING_DAYS = 90;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface WebSessionPolicy {
  idleHours: number;
  maxDays: number;
}

export interface SessionTimes {
  createdAt: Date;
  /** session.updatedAt — last recorded activity. */
  lastActivityAt: Date;
}

export type SessionVerdict =
  | {
      valid: true;
      /** true when last activity is older than the touch interval: refresh session.updatedAt. */
      shouldTouch: boolean;
      /** Earliest of the idle and absolute expiries (if no further activity happens). */
      expiresAt: Date;
      idleExpiresAt: Date;
      absoluteExpiresAt: Date;
    }
  | { valid: false; reason: 'idle' | 'absolute' };

export function absoluteExpiry(createdAt: Date, maxDays: number): Date {
  return new Date(createdAt.getTime() + maxDays * DAY_MS);
}

export function idleExpiry(lastActivityAt: Date, idleHours: number): Date {
  return new Date(lastActivityAt.getTime() + idleHours * HOUR_MS);
}

export function evaluateSessionPolicy(
  times: SessionTimes,
  policy: WebSessionPolicy,
  now: Date = new Date(),
): SessionVerdict {
  const absoluteExpiresAt = absoluteExpiry(times.createdAt, policy.maxDays);
  if (now.getTime() >= absoluteExpiresAt.getTime()) return { valid: false, reason: 'absolute' };
  // Activity can never predate creation (clock skew, imported rows).
  const lastActivity = Math.max(times.lastActivityAt.getTime(), times.createdAt.getTime());
  const idleExpiresAt = idleExpiry(new Date(lastActivity), policy.idleHours);
  if (now.getTime() >= idleExpiresAt.getTime()) return { valid: false, reason: 'idle' };
  const shouldTouch = now.getTime() - lastActivity >= SESSION_TOUCH_INTERVAL_MS;
  const nextIdleExpiry = shouldTouch ? idleExpiry(now, policy.idleHours) : idleExpiresAt;
  return {
    valid: true,
    shouldTouch,
    idleExpiresAt: nextIdleExpiry,
    absoluteExpiresAt,
    expiresAt: new Date(Math.min(nextIdleExpiry.getTime(), absoluteExpiresAt.getTime())),
  };
}

/**
 * GitHub sends the browser to these routes (app creation, installation): a device without a session
 * signs in first, then comes back to them. No other API route is ever a post-login target.
 */
export const BROWSER_API_ROUTES = /^\/api\/integrations\/github\/(callback|setup|install)(\?|$)/;

/** Safe post-login redirect target: only same-site absolute paths (no //host, no scheme). */
export function safeRedirectPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f\\]/.test(value)) return fallback;
  // Never bounce back into the auth pages.
  if (/^\/(connexion|configuration|deconnexion|invitation|recuperation)(\/|\?|$)/.test(value) || (value.startsWith('/api/') && !BROWSER_API_ROUTES.test(value))) return fallback;
  return value;
}

/**
 * Double authentification exigée ? `NUERA_REQUIRE_2FA=false` la rend facultative (décision du
 * propriétaire) : connexion par mot de passe seul pour un compte sans 2FA, étape d'activation
 * « Passer cette étape ». Un compte qui a activé sa 2FA la garde. Par défaut : exigée.
 */
export function twoFactorRequired(): boolean {
  return process.env.NUERA_REQUIRE_2FA?.trim().toLowerCase() !== 'false';
}
