/**
 * « Aperçu » — configuration of the preview origin (pure, shared by `src/proxy.ts`, the server
 * module `@/server/preview` and the tests).
 *
 * The previewed project's code is untrusted: it never runs on the application's origin. The same
 * web container answers a second host, `PREVIEW_HOST` (e.g. `nuera-dev-apercu.perso.nuera.studio`),
 * on which `src/proxy.ts` sends EVERY request to the runner of the run's server (external rewrite,
 * `server/preview/gate.ts`) or to the entry route handler (no application page, no application
 * API); on the application host that handler answers 404. Empty `PREVIEW_HOST` ⇒ the feature is off
 * and the Workspace says why.
 */

export const PREVIEW_COOKIE = 'nuera_apercu';
/** Entry point of a handoff on the preview host (`?jeton=`): sets the cookie, then redirects. */
export const PREVIEW_ENTRY_PATH = '/__nuera/entree';
/** Paths of the preview host kept for Nuera Dev (never relayed to the dev server). */
export const PREVIEW_RESERVED_PREFIX = '/__nuera/';
/** Internal route handler the proxy rewrites the entry of the preview host to. */
export const PREVIEW_ROUTES = { entry: '/api/apercu/entree' } as const;
/** Lifetime of the preview cookie (an access is re-checked on every request anyway). */
export const PREVIEW_COOKIE_TTL_MS = 12 * 3_600_000;
/** Lifetime of a handoff token (single use). */
export const PREVIEW_HANDOFF_TTL_MS = 60_000;

export type PreviewConfig =
  | {
      enabled: true;
      /** `nuera-dev-apercu.perso.nuera.studio` (lowercase, with `:port` when not the default one). */
      host: string;
      /** `https://nuera-dev-apercu.perso.nuera.studio` */
      origin: string;
      /** Origin of APP_URL: the only page allowed to frame the preview. */
      appOrigin: string;
      /**
       * `lax` when the preview host is same-site with the application (sub-domains of one domain, the
       * production setup); `none` otherwise (the cookie must then travel in a cross-site iframe).
       */
      sameSite: 'lax' | 'none';
      secure: boolean;
    }
  | { enabled: false; reason: string };

type Env = Record<string, string | undefined>;

const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** `Nuera-Dev-Apercu.Example.test:443` → `nuera-dev-apercu.example.test` (default port dropped); null if invalid. */
export function normalizeHost(value: string | null | undefined, protocol: 'http:' | 'https:' = 'https:'): string | null {
  if (!value) return null;
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 260 || !HOST_PATTERN.test(host)) return null;
  const [name, port] = host.split(':') as [string, string | undefined];
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
    if ((protocol === 'https:' && n === 443) || (protocol === 'http:' && n === 80)) return name;
  }
  return host;
}

function hostname(host: string): string {
  return host.split(':')[0] ?? host;
}

/**
 * Same « site » (registrable domain) for cookies: the two last labels match (`a.perso.nuera.studio`
 * and `b.perso.nuera.studio`). IP addresses and `localhost` are their own site. Approximation of the
 * public-suffix list: a wrong `true` (two hosts under `co.uk`) only makes the iframe lose its
 * cookie, never widens anything.
 */
export function sameSiteHosts(a: string, b: string): boolean {
  const x = hostname(a);
  const y = hostname(b);
  if (x === y) return true;
  if (IPV4.test(x) || IPV4.test(y) || x === 'localhost' || y === 'localhost') return false;
  const tail = (h: string) => h.split('.').slice(-2).join('.');
  return x.split('.').length >= 2 && y.split('.').length >= 2 && tail(x) === tail(y);
}

function appUrlOf(env: Env): URL | null {
  try {
    const url = new URL(env.APP_URL?.trim() || 'http://localhost:3000');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** PREVIEW_HOST (+ APP_URL) → the preview configuration, or why it is off (French, shown in the UI). */
export function readPreviewConfig(env: Env = process.env): PreviewConfig {
  const raw = env.PREVIEW_HOST?.trim();
  if (!raw) return { enabled: false, reason: "L'aperçu n'est pas activé sur ce serveur : la variable PREVIEW_HOST n'est pas définie." };
  const app = appUrlOf(env);
  if (!app) return { enabled: false, reason: "L'aperçu n'est pas activé : APP_URL n'est pas une adresse valide." };
  const protocol = app.protocol as 'http:' | 'https:';
  const host = normalizeHost(raw.replace(/^https?:\/\//i, '').replace(/\/+$/, ''), protocol);
  if (!host) return { enabled: false, reason: "L'aperçu n'est pas activé : PREVIEW_HOST n'est pas un nom d'hôte valide." };
  const appHost = normalizeHost(app.host, protocol);
  if (host === appHost) {
    return { enabled: false, reason: "L'aperçu n'est pas activé : PREVIEW_HOST doit désigner un autre hôte que celui de l'application." };
  }
  const sameSite = appHost && sameSiteHosts(host, appHost) ? 'lax' : 'none';
  const production = env.NODE_ENV === 'production';
  return {
    enabled: true,
    host,
    origin: `${protocol}//${host}`,
    appOrigin: app.origin,
    sameSite,
    // SameSite=None requires Secure (browsers accept it on http://localhost and 127.0.0.1 in tests).
    secure: production || protocol === 'https:' || sameSite === 'none',
  };
}

/** Host of a request as the browser sent it (`Host`), normalised; null when absent or invalid. */
export function requestHost(headers: Headers, protocol: 'http:' | 'https:' = 'https:'): string | null {
  return normalizeHost(headers.get('host'), protocol);
}

/** True for a request addressed to the preview host. */
export function isPreviewRequest(headers: Headers, config: Extract<PreviewConfig, { enabled: true }>): boolean {
  const protocol = new URL(config.origin).protocol as 'http:' | 'https:';
  return requestHost(headers, protocol) === config.host;
}

/**
 * Framing and isolation headers of every preview-host response: only the application may frame it
 * (`frame-ancestors`), and the obsolete `X-Frame-Options` of the application's own headers is
 * replaced (browsers ignore it once `frame-ancestors` is present).
 */
export function previewResponseHeaders(config: Extract<PreviewConfig, { enabled: true }>): Record<string, string> {
  return {
    'content-security-policy': `frame-ancestors ${config.appOrigin}`,
    'x-frame-options': `ALLOW-FROM ${config.appOrigin}`,
    'x-robots-tag': 'noindex, nofollow',
  };
}

/** Path + query asked of the preview (`/devis?id=3`), as typed in the Workspace field; null if unsafe. */
export function normalizePreviewPath(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  if (!text) return '/';
  const path = text.startsWith('/') ? text : `/${text}`;
  if (path.length > 2048 || path.startsWith('//') || /[\s\u0000-\u001f\u007f\\]/.test(path)) return null;
  if (path.startsWith(PREVIEW_RESERVED_PREFIX)) return null;
  return path;
}
