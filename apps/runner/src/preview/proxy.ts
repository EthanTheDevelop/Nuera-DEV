import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import net from 'node:net';
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
  RUNNER_PREVIEW_ROUTE,
  stripNueraCookies,
} from '@nuera/shared/runner';
import type { Logger } from 'pino';
import { RunnerError, toErrorBody } from '../errors';

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
 */

export interface PreviewTargets {
  previewTarget(runId: string): Promise<{ port: number }>;
}

const HOP = new Set<string>(HOP_BY_HOP_HEADERS);
const DROPPED_RESPONSE = new Set<string>(PREVIEW_DROPPED_RESPONSE_HEADERS);
const DROPPED_REQUEST = /^(?:host|authorization|content-length|accept-encoding|cookie|forwarded|via|x-real-ip|x-forwarded-.*|x-middleware-.*|x-nuera-.*|x-invoke-.*|x-matched-path)$/i;

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
export function downstreamResponseHeaders(incoming: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  const listed = connectionListedHeaders(incoming.connection);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase();
    if (value === undefined || HOP.has(key) || listed.has(key) || DROPPED_RESPONSE.has(key) || key.startsWith('x-nuera-')) continue;
    if (key === 'location' && typeof value === 'string') out.location = relativeLocation(value, port);
    else if (key === 'set-cookie') out['set-cookie'] = (Array.isArray(value) ? value : [value]).map(hostOnlyCookie);
    else out[key] = value;
  }
  out[PREVIEW_HEADERS.upstream] = 'upstream';
  out['cache-control'] ??= 'no-store';
  return out;
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

function writeError(reply: FastifyReply, error: RunnerError): void {
  const res = reply.raw;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(toErrorBody(error));
  res.writeHead(error.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function requestHasBody(request: FastifyRequest): boolean {
  const length = request.headers['content-length'];
  return length !== undefined ? length !== '0' : request.headers['transfer-encoding'] !== undefined;
}

function requestTarget(request: FastifyRequest, runId: string): string {
  const raw = request.raw.url ?? '';
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
    else writeError(reply, error);
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
    res.writeHead(status, downstreamResponseHeaders(incoming.headers, port));
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
    incoming.pipe(limit).pipe(res);
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

/**
 * Registers the relay in its own plugin scope: no body parser at all (bodies stay raw streams), any
 * method of the contract. The bearer check and the environment guard of the parent apply.
 */
export function registerPreviewProxy(app: FastifyInstance, deps: { runs: PreviewTargets; logger: Logger }): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, _payload, done) => done(null, undefined));
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
