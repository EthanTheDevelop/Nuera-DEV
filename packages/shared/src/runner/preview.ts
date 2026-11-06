import { RunParamsSchema } from './runs';

/**
 * « Aperçu » — raw HTTP relay from the web to the dev server of a live `dev` run (contract shared by
 * the runner, which serves it, and the web, which streams the browser's requests to it).
 *
 *   <METHOD> /v1/runs/:runId/preview<path and query of the previewed site>
 *
 * Unlike RUNNER_ROUTES (JSON bodies validated by Zod), this route takes ANY method of
 * {@link PREVIEW_METHODS} and streams both bodies untouched. The runner only ever connects to the
 * loopback port detected for THAT run (`command_runs.port`, `kind = 'dev'`, process alive): no host,
 * port or scheme comes from the request. It answers either the dev server's own response, marked
 * with {@link PREVIEW_HEADERS.upstream}, or a runner error body (`{ error: { code, message, reason } }`).
 */
export const PREVIEW_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export type PreviewMethod = (typeof PREVIEW_METHODS)[number];

export const RUNNER_PREVIEW_ROUTE = {
  path: '/v1/runs/:runId/preview',
  params: RunParamsSchema,
} as const;

/** Headers of the web ⇄ runner hop (never sent to the dev server, never returned to the browser). */
export const PREVIEW_HEADERS = {
  /** Set by the runner on a response that comes from the dev server (absent: runner error body). */
  upstream: 'x-nuera-preview',
  /** The browser's own `Authorization` (the hop's one carries the runner token). */
  authorization: 'x-nuera-preview-authorization',
  /** Original `Content-Length` (fetch streams the body chunked). */
  contentLength: 'x-nuera-preview-content-length',
  /** Origin of the preview host (`https://nuera-dev-apercu…`): Origin / Referer are rewritten to the dev server's. */
  origin: 'x-nuera-preview-origin',
} as const;

export const PREVIEW_LIMITS = {
  /** Request body (uploads of the previewed site). */
  requestBodyBytes: 10 * 1024 * 1024,
  /** Response body (bundles, images, source maps). */
  responseBodyBytes: 256 * 1024 * 1024,
  /** No byte in either direction for this long: the exchange is cut. */
  idleMs: 60_000,
  /** Longest exchange (event streams of the previewed site included). */
  totalMs: 10 * 60_000,
  /** Longest path + query relayed. */
  pathLength: 8192,
} as const;

/**
 * Path (+ query) of the previewed site: absolute (`/…`), never protocol-relative (`//host`), no
 * whitespace, control character or backslash, bounded. The runner puts it after
 * `http://<loopback>:<port>` verbatim (request target), so nothing here can change host or port.
 */
export function isSafePreviewPath(value: string): boolean {
  if (value.length === 0 || value.length > PREVIEW_LIMITS.pathLength) return false;
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  return !/[\s\u0000-\u001f\u007f\\]/.test(value);
}

/** `/v1/runs/<id>/preview/src/main.ts?t=1` */
export function previewRunnerPath(runId: string, pathAndQuery: string): string {
  if (!isSafePreviewPath(pathAndQuery)) throw new Error("Chemin d'aperçu invalide.");
  return `/v1/runs/${encodeURIComponent(runId)}/preview${pathAndQuery}`;
}

/** Response headers of the dev server that never reach the browser (the web sets its own framing rules). */
export const PREVIEW_DROPPED_RESPONSE_HEADERS = [
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'alt-svc',
] as const;

/** RFC 9110 §7.6.1 hop-by-hop fields (plus the legacy ones), never forwarded by a proxy. */
export const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
] as const;

/** Header names listed in `Connection` (`Connection: close, x-foo`) are hop-by-hop too. */
export function connectionListedHeaders(connection: string | string[] | null | undefined): Set<string> {
  const values = Array.isArray(connection) ? connection : connection ? [connection] : [];
  const names = new Set<string>();
  for (const value of values) for (const part of value.split(',')) if (part.trim()) names.add(part.trim().toLowerCase());
  return names;
}

/** Cookies of Nuera Dev itself (session, 2FA, preview access): never relayed to a previewed site. */
export function isNueraCookieName(name: string): boolean {
  return /^(?:__secure-|__host-)?nuera[._]/i.test(name.trim());
}

/** `Cookie` header without Nuera Dev's own cookies (null when nothing is left). */
export function stripNueraCookies(header: string | null | undefined): string | null {
  if (!header) return null;
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !isNueraCookieName(part.split('=')[0] ?? ''));
  return kept.length > 0 ? kept.join('; ') : null;
}
