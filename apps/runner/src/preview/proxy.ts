import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { Transform, type TransformCallback } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  connectionListedHeaders,
  HOP_BY_HOP_HEADERS,
  isSafePreviewPath,
  PREVIEW_DROPPED_RESPONSE_HEADERS,
  PREVIEW_HEADERS,
  PREVIEW_LIMITS,
  PREVIEW_METHODS,
  PREVIEW_SCAN_LIMIT,
  previewInsertionOffset,
  previewMessageHtml,
  previewPositionScript,
  RUNNER_PREVIEW_ROUTE,
  RunParamsSchema,
  stripNueraCookies,
} from '@nuera/shared/runner';
import type { Logger } from 'pino';
import { RunnerError, toErrorBody } from '../errors';
import { bearerMatches } from '../http/route';

/**
 * « Aperçu » relay (`<METHOD> /v1/runs/:runId/preview/*`, contract in `@nuera/shared/runner`
 * preview.ts): streams one request of the web to the dev server of a live `dev` run and its answer
 * back. The target is ALWAYS `<loopback>:<port detected for that run>`; the request only chooses
 * the method, the path and the body.
 *
 * Request: hop-by-hop fields, `Host`, the hop's `Authorization` (runner token), `X-Forwarded-*`,
 * Nuera Dev's cookies and every `x-nuera-*` field are removed; `Host` becomes `localhost:<port>`
 * (Vite / Next dev servers refuse unknown hosts), `Origin` / `Referer` of the preview host become the
 * dev server's own, `Accept-Encoding: identity` (bytes relayed as they are, no recompression).
 * Response: hop-by-hop fields and the framing rules of the dev server (`X-Frame-Options`, CSP, HSTS)
 * are removed (the web sets its own), a `Location` pointing at the dev server becomes relative, a
 * `Set-Cookie` loses its `Domain` (host-only on the preview host).
 * Limits: request body {@link PREVIEW_LIMITS.requestBodyBytes}, response body
 * {@link PREVIEW_LIMITS.responseBodyBytes}, {@link PREVIEW_LIMITS.idleMs} without a byte,
 * {@link PREVIEW_LIMITS.totalMs} per exchange.
 *
 * « Direct » mode (`x-nuera-preview-app-origin`: the web hands the browser's request over as it
 * is, see `@nuera/shared/runner` preview.ts): errors become the short French page, an HTML page
 * gets the position script after its `<head>` (its `Content-Length` dropped), no marker. WebSocket
 * upgrades (hot reload: `next dev` does not even hydrate without its socket) are relayed the same
 * way, bytes piped both ways, at most {@link PREVIEW_LIMITS.websocketMs}.
 */

export interface PreviewTargets {
  previewTarget(runId: string): Promise<{ port: number }>;
}

/** `x-nuera-preview-app-origin` when it is a plain http(s) origin (direct mode), else null. */
export function directAppOrigin(headers: IncomingHttpHeaders): string | null {
  const value = single(headers[PREVIEW_HEADERS.appOrigin]);
  if (!value || !/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(value)) return null;
  return value;
}

const HOP = new Set<string>(HOP_BY_HOP_HEADERS);
const DROPPED_RESPONSE = new Set<string>(PREVIEW_DROPPED_RESPONSE_HEADERS);
// The last names are the web's own response headers, which Next.js copies onto a rewritten request.
const DROPPED_REQUEST = /^(?:host|authorization|content-length|accept-encoding|cookie|forwarded|via|x-real-ip|x-forwarded-.*|x-middleware-.*|x-nuera-.*|x-invoke-.*|x-matched-path|content-security-policy|x-frame-options|x-robots-tag)$/i;

/** Headers sent to the dev server (see the module comment). */
export function upstreamRequestHeaders(incoming: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  const listed = connectionListedHeaders(incoming.connection);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase();
    if (value === undefined || HOP.has(key) || listed.has(key) || DROPPED_REQUEST.test(key)) continue;
    out[key] = value;
  }
  const local = `http://localhost:${port}`;
  out.host = `localhost:${port}`;
  out['accept-encoding'] = 'identity';
  const cookie = stripNueraCookies(Array.isArray(incoming.cookie) ? incoming.cookie.join('; ') : incoming.cookie);
  if (cookie) out.cookie = cookie;
  const authorization = single(incoming[PREVIEW_HEADERS.authorization]);
  if (authorization) out.authorization = authorization;
  // The bytes piped are the hop's body: its own length first, else the browser's (the web streams it).
  const length = single(incoming['content-length']) ?? single(incoming[PREVIEW_HEADERS.contentLength]);
  if (length && /^\d{1,12}$/.test(length) && Number(length) <= PREVIEW_LIMITS.requestBodyBytes) out['content-length'] = length;
  const previewOrigin = single(incoming[PREVIEW_HEADERS.origin]);
  if (previewOrigin) {
    const origin = single(incoming.origin);
    if (origin && origin === previewOrigin) out.origin = local;
    const referer = single(incoming.referer);
    if (referer && (referer === previewOrigin || referer.startsWith(`${previewOrigin}/`))) out.referer = `${local}${referer.slice(previewOrigin.length) || '/'}`;
  }
  return out;
}

function single(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]']);

/** `http://localhost:5173/connexion?x=1` → `/connexion?x=1` (only for the dev server's own origin). */
export function relativeLocation(location: string, port: number): string {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return location; // already relative (or unparseable: left as is)
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !LOCAL_HOSTS.has(url.hostname.toLowerCase())) return location;
  const urlPort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (urlPort !== port) return location;
  return `${url.pathname}${url.search}${url.hash}` || '/';
}

/** `a=1; Path=/; Domain=example.test; HttpOnly` → `a=1; Path=/; HttpOnly` (host-only cookie). */
export function hostOnlyCookie(value: string): string {
  return value
    .split(';')
    .filter((part, index) => index === 0 || !/^\s*domain\s*=/i.test(part))
    .join(';');
}

/** Headers returned to the web (see the module comment). */
export function downstreamResponseHeaders(incoming: IncomingHttpHeaders, port: number, options: { direct?: boolean; injected?: boolean; path?: string } = {}): OutgoingHttpHeaders {
  const listed = connectionListedHeaders(incoming.connection);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase();
    if (value === undefined || HOP.has(key) || listed.has(key) || DROPPED_RESPONSE.has(key) || key.startsWith('x-nuera-')) continue;
    if (options.injected && key === 'content-length') continue;
    if (key === 'location' && typeof value === 'string') out.location = relativeLocation(value, port);
    else if (key === 'set-cookie') out['set-cookie'] = (Array.isArray(value) ? value : [value]).map(hostOnlyCookie);
    else out[key] = value;
  }
  if (!options.direct) out[PREVIEW_HEADERS.upstream] = 'upstream';
  // Next.js answers an external rewrite with its target in `x-middleware-rewrite` (runner address,
  // run id): the proxied answer's own value replaces it.
  else out['x-middleware-rewrite'] = options.path ?? '/';
  out['cache-control'] ??= 'no-store';
  return out;
}

/** True for a dev server page that gets the position script (HTML, 200). */
export function isInjectablePage(status: number, headers: IncomingHttpHeaders): boolean {
  return status === 200 && /^text\/html\b/i.test(single(headers['content-type']) ?? '') && !single(headers['content-encoding']);
}

/**
 * Inserts `snippet` right after the first `<head …>` (else `<body …>`) of a streamed HTML body,
 * looking at its first {@link PREVIEW_SCAN_LIMIT} bytes only (latin1 scan: UTF-8 never re-encoded);
 * without either tag in that window the body passes unchanged.
 */
export class InjectAfterHead extends Transform {
  private pending: Buffer[] = [];
  private size = 0;
  private done = false;
  private readonly extra: Buffer;
  constructor(snippet: string) {
    super();
    this.extra = Buffer.from(snippet, 'utf8');
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.done) return callback(null, chunk);
    this.pending.push(chunk);
    this.size += chunk.length;
    const joined = Buffer.concat(this.pending);
    const at = previewInsertionOffset(joined.toString('latin1'));
    if (at >= 0) {
      this.done = true;
      this.pending = [];
      return callback(null, Buffer.concat([joined.subarray(0, at), this.extra, joined.subarray(at)]));
    }
    if (this.size >= PREVIEW_SCAN_LIMIT) {
      this.done = true;
      this.pending = [];
      return callback(null, joined);
    }
    callback();
  }
  override _flush(callback: TransformCallback): void {
    callback(null, this.pending.length > 0 ? Buffer.concat(this.pending) : undefined);
  }
}

const ERROR_TITLE = 'Aperçu indisponible';

/** Runner error → the page shown in the frame (direct mode). */
export function previewErrorPage(error: RunnerError): { status: number; body: string } {
  return { status: error.status, body: previewMessageHtml(ERROR_TITLE, error.message) };
}

/** Fails the stream once more than `max` bytes went through. */
class ByteLimit extends Transform {
  private seen = 0;
  constructor(
    private readonly max: number,
    private readonly onByte: () => void,
  ) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.seen += chunk.length;
    this.onByte();
    if (this.seen > this.max) return done(new RunnerError('VALIDATION', 'Contenu trop volumineux pour l\'aperçu.', { reason: 'PREVIEW_TOO_LARGE', status: 413 }));
    done(null, chunk);
  }
}

const loopbackCache = new Map<number, { host: string; expiresAt: number }>();

function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Loopback address the dev server listens on: 127.0.0.1, else ::1 (Vite on `localhost` may bind
 * the IPv6 one only). Remembered 10 s per port.
 */
async function loopbackFor(port: number): Promise<string> {
  const cached = loopbackCache.get(port);
  if (cached && cached.expiresAt > Date.now()) return cached.host;
  for (const host of ['127.0.0.1', '::1']) {
    if (await canConnect(host, port, 2_000)) {
      loopbackCache.set(port, { host, expiresAt: Date.now() + 10_000 });
      return host;
    }
  }
  loopbackCache.delete(port);
  throw new RunnerError('UPSTREAM', `Le serveur de développement ne répond pas sur le port ${port}.`, { reason: 'PREVIEW_UNREACHABLE' });
}

/** `/v1/runs/<id>/preview/devis?x=1` → `/devis?x=1` (what the browser asked). */
function browserPath(raw: string | undefined): string {
  const rest = (raw ?? '').replace(/^\/v1\/runs\/[^/?#]+\/preview/, '');
  return rest.startsWith('/') ? rest : `/${rest}`;
}

function writeError(reply: FastifyReply, error: RunnerError, direct: boolean): void {
  const res = reply.raw;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const page = direct ? previewErrorPage(error) : null;
  const body = page ? page.body : JSON.stringify(toErrorBody(error));
  const type = page ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8';
  res.writeHead(error.status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...(direct ? { 'x-middleware-rewrite': browserPath(reply.request.raw.url) } : {}),
  });
  res.end(body);
}

function requestHasBody(request: FastifyRequest): boolean {
  const length = request.headers['content-length'];
  return length !== undefined ? length !== '0' : request.headers['transfer-encoding'] !== undefined;
}

function requestTarget(request: FastifyRequest, runId: string): string {
  return targetOf(request.raw.url ?? '', runId);
}

function targetOf(raw: string, runId: string): string {
  const prefix = `/v1/runs/${runId}/preview`;
  const start = raw.indexOf(prefix);
  let rest = start === 0 ? raw.slice(prefix.length) : '/';
  if (!rest.startsWith('/')) rest = `/${rest}`;
  if (!isSafePreviewPath(rest)) throw new RunnerError('VALIDATION', "Chemin d'aperçu invalide.", { reason: 'PATH_REJECTED' });
  return rest;
}

async function relay(request: FastifyRequest, reply: FastifyReply, targets: PreviewTargets, logger: Logger): Promise<void> {
  const { runId } = RUNNER_PREVIEW_ROUTE.params.parse({ runId: (request.params as { runId?: unknown }).runId });
  const path = requestTarget(request, runId);
  const { port } = await targets.previewTarget(runId);
  const host = await loopbackFor(port);
  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const appOrigin = directAppOrigin(request.headers);
  const direct = appOrigin !== null;

  reply.hijack();
  const res = reply.raw;
  let finished = false;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const total = setTimeout(() => abort(new RunnerError('UPSTREAM', "L'échange avec le serveur de développement a duré trop longtemps.", { reason: 'TIMEOUT' })), PREVIEW_LIMITS.totalMs);
  total.unref?.();
  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => abort(new RunnerError('UPSTREAM', 'Le serveur de développement ne répond plus.', { reason: 'TIMEOUT' })), PREVIEW_LIMITS.idleMs);
    idle.unref?.();
  };
  const cleanup = () => {
    finished = true;
    clearTimeout(total);
    if (idle) clearTimeout(idle);
  };

  const headers = upstreamRequestHeaders(request.headers, port);
  // Node frames DELETE / OPTIONS bodies only when told so: an unknown length is sent chunked.
  if (hasBody && headers['content-length'] === undefined && requestHasBody(request)) headers['transfer-encoding'] = 'chunked';
  const upstream = http.request({ host, port, method, path, headers, setHost: false });
  function abort(error: RunnerError): void {
    if (finished) return;
    cleanup();
    upstream.destroy();
    if (res.headersSent) res.destroy();
    else writeError(reply, error, direct);
  }
  touch();

  // The web went away (tab closed, navigation): stop talking to the dev server.
  res.on('close', () => {
    if (!res.writableFinished) {
      cleanup();
      upstream.destroy();
    }
  });

  upstream.on('response', (incoming) => {
    touch();
    const status = incoming.statusCode ?? 502;
    const inject = direct && method !== 'HEAD' && isInjectablePage(status, incoming.headers);
    res.writeHead(status, downstreamResponseHeaders(incoming.headers, port, { direct, injected: inject, path }));
    if (method === 'HEAD' || status === 204 || status === 304) {
      incoming.resume();
      incoming.on('end', () => {
        cleanup();
        res.end();
      });
      return;
    }
    const limit = new ByteLimit(PREVIEW_LIMITS.responseBodyBytes, touch);
    limit.on('error', (error) => abort(error instanceof RunnerError ? error : new RunnerError('UPSTREAM', 'Réponse du serveur de développement interrompue.')));
    incoming.on('error', () => abort(new RunnerError('UPSTREAM', 'Réponse du serveur de développement interrompue.')));
    if (inject) incoming.pipe(limit).pipe(new InjectAfterHead(previewPositionScript(appOrigin))).pipe(res);
    else incoming.pipe(limit).pipe(res);
    res.on('finish', cleanup);
  });
  upstream.on('error', (error) => {
    if (finished) return;
    logger.debug({ err: error, runId, port }, 'aperçu : échange interrompu');
    abort(new RunnerError('UPSTREAM', `Le serveur de développement ne répond pas sur le port ${port}.`, { reason: 'PREVIEW_UNREACHABLE' }));
  });

  if (!hasBody) {
    upstream.end();
    return;
  }
  const limit = new ByteLimit(PREVIEW_LIMITS.requestBodyBytes, touch);
  limit.on('error', (error) => abort(error instanceof RunnerError ? error : new RunnerError('VALIDATION', 'Requête interrompue.')));
  request.raw.on('error', () => abort(new RunnerError('VALIDATION', 'Requête interrompue.')));
  request.raw.pipe(limit).pipe(upstream);
}

// --- WebSocket upgrades -----------------------------------------------------------------------------

const UPGRADE_PATH = /^\/v1\/runs\/([^/?#]+)\/preview(?:[/?]|$)/;
const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 409: 'Conflict', 502: 'Bad Gateway', 503: 'Service Unavailable' };

function refuseUpgrade(socket: Duplex, status: number): void {
  if (!socket.writable) return void socket.destroy();
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Raw header block (`Name: value\r\n…`) of an upstream answer, framing rules and Nuera markers removed. */
function rawHeaderBlock(incoming: IncomingMessage, port: number, keepUpgrade: boolean): string {
  const headers = downstreamResponseHeaders(incoming.headers, port, { direct: true });
  delete headers['cache-control'];
  if (incoming.headers['cache-control']) headers['cache-control'] = incoming.headers['cache-control'];
  if (keepUpgrade) {
    headers.connection = 'Upgrade';
    headers.upgrade = incoming.headers.upgrade ?? 'websocket';
  } else {
    headers.connection = 'close';
  }
  let block = '';
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [String(value)]) {
      if (/[\r\n]/.test(item)) continue;
      block += `${name}: ${item}\r\n`;
    }
  }
  return block;
}

export interface UpgradeDeps {
  runs: PreviewTargets;
  logger: Logger;
  token: string;
  environment: { readonly serving: boolean };
}

/**
 * `GET /v1/runs/:runId/preview/*` with `Upgrade: websocket`, Bearer of the server: the same checks
 * as the HTTP relay (live dev run of this server, its loopback port only), then bytes piped both
 * ways. Anything else on the upgrade path is refused (socket closed).
 */
export function handlePreviewUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, deps: UpgradeDeps): void {
  socket.on('error', () => socket.destroy());
  const match = UPGRADE_PATH.exec(request.url ?? '');
  if (!match) return refuseUpgrade(socket, 404);
  if (!bearerMatches(request.headers.authorization, deps.token)) return refuseUpgrade(socket, 401);
  if (!deps.environment.serving) return refuseUpgrade(socket, 503);
  if ((request.headers.upgrade ?? '').toLowerCase() !== 'websocket' || (request.method ?? 'GET').toUpperCase() !== 'GET') return refuseUpgrade(socket, 400);
  const params = RunParamsSchema.safeParse({ runId: decodeURIComponent(match[1] ?? '') });
  if (!params.success) return refuseUpgrade(socket, 404);
  const runId = params.data.runId;
  let path: string;
  try {
    path = targetOf(request.url ?? '', runId);
  } catch {
    return refuseUpgrade(socket, 400);
  }
  void (async () => {
    let port: number;
    let host: string;
    try {
      port = (await deps.runs.previewTarget(runId)).port;
      host = await loopbackFor(port);
    } catch (error) {
      return refuseUpgrade(socket, error instanceof RunnerError ? error.status : 502);
    }
    const headers = upstreamRequestHeaders(request.headers, port);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    const upstream = http.request({ host, port, method: 'GET', path, headers, setHost: false });
    let open: Duplex | null = null;
    const total = setTimeout(() => close(), PREVIEW_LIMITS.websocketMs);
    total.unref?.();
    const close = () => {
      clearTimeout(total);
      upstream.destroy();
      open?.destroy();
      socket.destroy();
    };
    // Either side going away ends both (the sockets are half-open after an upgrade).
    socket.on('close', close);
    socket.on('end', close);
    upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
      open = upstreamSocket;
      upstreamSocket.on('error', close);
      upstreamSocket.on('close', close);
      upstreamSocket.on('end', close);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${rawHeaderBlock(answer, port, true)}\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    // The dev server refused the upgrade: its answer goes back as it is, then the socket closes.
    upstream.on('response', (answer) => {
      socket.write(`HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ''}\r\n${rawHeaderBlock(answer, port, false)}\r\n`);
      answer.pipe(socket);
      answer.on('end', close);
    });
    upstream.on('error', (error) => {
      deps.logger.debug({ err: error, runId, port }, 'aperçu : WebSocket interrompu');
      if (open) close();
      else refuseUpgrade(socket, 502);
    });
    upstream.end();
  })();
}

/**
 * Registers the relay in its own plugin scope: no body parser at all (bodies stay raw streams), any
 * method of the contract. The bearer check and the environment guard of the parent apply; in direct
 * mode their refusals (JSON) become the French page too. WebSocket upgrades of the same path are
 * taken on the HTTP server itself ({@link handlePreviewUpgrade}).
 */
export function registerPreviewProxy(app: FastifyInstance, deps: UpgradeDeps): void {
  // Open sockets would hold the runner's shutdown (a hot-reload socket lives up to an hour).
  const sockets = new Set<Duplex>();
  app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    handlePreviewUpgrade(request, socket, head, deps);
  });
  app.addHook('preClose', async () => {
    // Normally empty: both sides of a relayed socket end together.
    for (const socket of sockets) socket.destroy();
  });
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, _payload, done) => done(null, undefined));
    scope.addHook('onSend', async (request, reply, payload) => {
      if (reply.statusCode < 400 || typeof payload !== 'string' || !directAppOrigin(request.headers)) return payload;
      let message = 'Le runner a refusé la requête.';
      try {
        const parsed = JSON.parse(payload) as { error?: { message?: unknown } };
        if (typeof parsed.error?.message === 'string') message = parsed.error.message;
      } catch {
        return payload;
      }
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.header('cache-control', 'no-store');
      reply.header('x-middleware-rewrite', browserPath(request.raw.url));
      return previewMessageHtml(ERROR_TITLE, message);
    });
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await relay(request, reply, deps.runs, deps.logger);
      } catch (error) {
        if (!reply.sent && !reply.raw.headersSent) throw error;
        deps.logger.warn({ err: error }, 'aperçu : erreur après le début de la réponse');
      }
    };
    for (const url of [RUNNER_PREVIEW_ROUTE.path, `${RUNNER_PREVIEW_ROUTE.path}/*`]) {
      scope.route({ method: [...PREVIEW_METHODS], url, exposeHeadRoute: false, handler });
    }
  });
}
