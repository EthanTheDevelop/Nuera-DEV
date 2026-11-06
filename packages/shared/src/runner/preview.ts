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
 *
 * « Direct » mode ({@link PREVIEW_HEADERS.appOrigin} on the request): the web's proxy hands the
 * browser's request to the runner as it is (Next.js external rewrite, WebSocket upgrades included)
 * and the answer goes back to the browser untouched. The runner then answers its errors as the
 * short French page of {@link previewMessageHtml} (never JSON), adds {@link previewPositionScript}
 * after the `<head>` of an HTML page and leaves out the `x-nuera-preview` marker.
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
  /** Origin of APP_URL (the only page that may frame the preview): its presence selects the « direct » mode. */
  appOrigin: 'x-nuera-preview-app-origin',
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
  /** Longest WebSocket (hot reload of the dev server): the page reconnects by itself afterwards. */
  websocketMs: 60 * 60_000,
} as const;

/** Message posted by {@link previewPositionScript} (read by the Workspace). */
export const PREVIEW_POSITION_MESSAGE = 'nuera-apercu:position';

/**
 * Added to the dev server's HTML pages, after `<head>`: posts `location` (path + query + hash) to
 * the application — and to it only (`targetOrigin`) — at load and on every client-side navigation,
 * so the path field and « Recharger » follow the page actually shown. Inert outside a frame.
 */
export function previewPositionScript(appOrigin: string): string {
  const target = JSON.stringify(appOrigin).replace(/</g, '\\u003c');
  return (
    `<script data-nuera-apercu>(function(){if(window.parent===window)return;var o=${target};` +
    `function s(){try{window.parent.postMessage({type:${JSON.stringify(PREVIEW_POSITION_MESSAGE)},path:location.pathname+location.search+location.hash},o)}catch(e){}}` +
    `s();addEventListener("popstate",s);addEventListener("hashchange",s);` +
    `["pushState","replaceState"].forEach(function(m){var f=history[m];history[m]=function(){var r=f.apply(this,arguments);s();return r}})})();</script>`
  );
}

const HEAD_TAG = /<head(?:\s[^>]*)?>/i;
const BODY_TAG = /<body(?:\s[^>]*)?>/i;
/** Bytes of an HTML page looked at for its `<head>` (then the page passes unchanged). */
export const PREVIEW_SCAN_LIMIT = 64 * 1024;

/**
 * Offset right after the first `<head …>` (else `<body …>`) of the start of an HTML page read as
 * latin1 (1 byte = 1 char, so the offset is a byte offset); -1 when neither is there yet.
 */
export function previewInsertionOffset(latin1: string): number {
  const match = HEAD_TAG.exec(latin1) ?? BODY_TAG.exec(latin1);
  return match ? match.index + match[0].length : -1;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}

/** Small page shown in the frame (or the tab) when the preview cannot be served. */
export function previewMessageHtml(title: string, message: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}main{max-width:28rem}h1{font-size:17px;margin:0 0 6px}p{margin:0;opacity:.75}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

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
