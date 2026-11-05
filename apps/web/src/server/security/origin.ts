import 'server-only';
import { AppError } from '@/server/errors';

/**
 * CSRF protection for mutations: the request must come from the application's own origin.
 *
 * Accepted origins: APP_URL's origin; outside production, also the origin derived from the
 * request's own Host header (so http://127.0.0.1:<port> works in development). Browsers always
 * send `Origin` on POST/PUT/PATCH/DELETE; without it we fall back to `Sec-Fetch-Site` and then to
 * `Referer`, and refuse when none of them proves a same-origin request.
 * Cookies are SameSite=Lax as a second layer (Better Auth default).
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginCheckInput {
  method: string;
  origin: string | null;
  referer: string | null;
  host: string | null;
  secFetchSite: string | null;
  /** Usually process.env.APP_URL. */
  appUrl: string | undefined;
  isProduction: boolean;
  /** Protocol used to rebuild the request origin from Host (default http in dev). */
  protocol?: 'http' | 'https';
}

export type OriginCheckResult = { ok: true } | { ok: false; reason: string };

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Origins allowed to send mutations. */
export function allowedOrigins(input: Pick<OriginCheckInput, 'appUrl' | 'host' | 'isProduction' | 'protocol'>): string[] {
  const origins = new Set<string>();
  const app = originOf(input.appUrl);
  if (app) origins.add(app);
  if (!input.isProduction && input.host && /^[A-Za-z0-9.\-[\]:]+$/.test(input.host)) {
    const fromHost = originOf(`${input.protocol ?? 'http'}://${input.host}`);
    if (fromHost) origins.add(fromHost);
  }
  return [...origins];
}

/** Pure decision function (unit-tested). */
export function checkOrigin(input: OriginCheckInput): OriginCheckResult {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  const allowed = allowedOrigins(input);
  if (allowed.length === 0) return { ok: false, reason: "APP_URL n'est pas configurée." };

  if (input.origin !== null) {
    if (input.origin === 'null') return { ok: false, reason: 'Origine opaque refusée.' };
    const origin = originOf(input.origin);
    return origin && allowed.includes(origin)
      ? { ok: true }
      : { ok: false, reason: `Origine refusée : ${input.origin}` };
  }
  const site = input.secFetchSite?.toLowerCase();
  if (site === 'same-origin') return { ok: true };
  if (site === 'cross-site' || site === 'same-site') return { ok: false, reason: 'Requête inter-sites refusée.' };
  const refererOrigin = originOf(input.referer);
  if (refererOrigin && allowed.includes(refererOrigin)) return { ok: true };
  return { ok: false, reason: 'Origine absente : requête refusée.' };
}

/** Reads the relevant headers of a request and applies `checkOrigin`. */
export function checkRequestOrigin(request: Request): OriginCheckResult {
  const headers = request.headers;
  let protocol: 'http' | 'https' = 'http';
  try {
    protocol = new URL(request.url).protocol === 'https:' ? 'https' : 'http';
  } catch {
    // keep http
  }
  return checkOrigin({
    method: request.method,
    origin: headers.get('origin'),
    referer: headers.get('referer'),
    host: headers.get('host'),
    secFetchSite: headers.get('sec-fetch-site'),
    appUrl: process.env.APP_URL,
    isProduction: process.env.NODE_ENV === 'production',
    protocol,
  });
}

/** Throws AppError FORBIDDEN when a mutation does not come from the application's origin. */
export function assertSameOrigin(request: Request): void {
  const result = checkRequestOrigin(request);
  if (!result.ok) {
    throw new AppError('FORBIDDEN', 'Requête refusée : origine non autorisée.', { detail: result.reason });
  }
}

/** Same check for Server Actions / RSC, from `await headers()`. */
export function assertSameOriginHeaders(headers: Headers, method = 'POST'): void {
  const result = checkOrigin({
    method,
    origin: headers.get('origin'),
    referer: headers.get('referer'),
    host: headers.get('host'),
    secFetchSite: headers.get('sec-fetch-site'),
    appUrl: process.env.APP_URL,
    isProduction: process.env.NODE_ENV === 'production',
    protocol: headers.get('x-forwarded-proto') === 'https' ? 'https' : 'http',
  });
  if (!result.ok) {
    throw new AppError('FORBIDDEN', 'Requête refusée : origine non autorisée.', { detail: result.reason });
  }
}
