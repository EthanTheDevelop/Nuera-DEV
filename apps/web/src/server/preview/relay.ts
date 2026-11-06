import 'server-only';
import {
  connectionListedHeaders,
  HOP_BY_HOP_HEADERS,
  PREVIEW_HEADERS,
  PREVIEW_LIMITS,
  previewRunnerPath,
  RunnerErrorBodySchema,
  stripNueraCookies,
} from '@nuera/shared/runner';
import { hashToken } from '@nuera/shared/tokens';
import type { PreviewConfig } from '@/lib/preview';
import { promoteRunnerToken } from '@/server/admin/token-rotation';
import { runnerUnavailableMessage } from '@/server/runner/client';
import type { PreviewAccess } from './access';
import { injectAfterHead, positionScript, previewMessagePage } from './html';

/**
 * Streams one request of the preview host to `/v1/runs/<id>/preview<path>` on the runner of the
 * run's server, and its answer back (both bodies streamed, never buffered). Browser → runner: the
 * hop-by-hop fields, `Host`, Nuera Dev's cookies and internal headers are dropped, the browser's own
 * `Authorization` and `Content-Length` travel in `x-nuera-preview-*` (the hop's `Authorization` is
 * the runner token). The connection timer is cleared once the runner answers (an AbortSignal timeout
 * would also cut the body: CLAUDE.md). A runner error (no `x-nuera-preview` marker) becomes a short
 * French page in the frame. An HTML page of the dev server gets the position script
 * ({@link positionScript}) after its `<head>`.
 */

const CONNECT_TIMEOUT_MS = 30_000;
const HOP = new Set<string>(HOP_BY_HOP_HEADERS);
const DROPPED = /^(?:host|cookie|authorization|content-length|accept-encoding|expect|forwarded|via|x-real-ip|x-forwarded-.*|x-middleware-.*|x-invoke-.*|x-nuera-.*|x-matched-path|x-next-.*)$/i;
const NO_BODY_STATUS = new Set([101, 204, 205, 304]);

export function previewRequestHeaders(source: Headers, config: Extract<PreviewConfig, { enabled: true }>, token: string): Headers {
  const listed = connectionListedHeaders(source.get('connection'));
  const out = new Headers();
  source.forEach((value, name) => {
    const key = name.toLowerCase();
    if (HOP.has(key) || listed.has(key) || DROPPED.test(key)) return;
    out.set(key, value);
  });
  const cookie = stripNueraCookies(source.get('cookie'));
  if (cookie) out.set('cookie', cookie);
  const authorization = source.get('authorization');
  if (authorization) out.set(PREVIEW_HEADERS.authorization, authorization);
  const length = source.get('content-length');
  if (length && /^\d{1,12}$/.test(length)) out.set(PREVIEW_HEADERS.contentLength, length);
  out.set(PREVIEW_HEADERS.origin, config.origin);
  out.set('authorization', `Bearer ${token}`);
  return out;
}

export function previewResponseHeadersFrom(source: Headers): Headers {
  const listed = connectionListedHeaders(source.get('connection'));
  const out = new Headers();
  source.forEach((value, name) => {
    const key = name.toLowerCase();
    if (HOP.has(key) || listed.has(key) || key === 'set-cookie' || key === 'content-length' || key === 'content-encoding' || key.startsWith('x-nuera-')) return;
    out.set(key, value);
  });
  for (const cookie of source.getSetCookie()) out.append('set-cookie', cookie);
  return out;
}

/** Fails the request body once it passes {@link PREVIEW_LIMITS.requestBodyBytes}. */
function limitedBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.length;
        if (seen > PREVIEW_LIMITS.requestBodyBytes) controller.error(new Error('Corps de requête trop volumineux.'));
        else controller.enqueue(chunk);
      },
    }),
  );
}

async function runnerErrorPage(response: Response, environmentName: string): Promise<Response> {
  const text = await response.text().catch(() => '');
  let message = '';
  try {
    const parsed = RunnerErrorBodySchema.safeParse(JSON.parse(text));
    if (parsed.success) message = parsed.data.error.message;
  } catch {
    message = '';
  }
  if (response.status === 401 || response.status === 503) {
    return previewMessagePage(503, 'Aperçu indisponible', runnerUnavailableMessage(environmentName));
  }
  if (response.status === 404 && !message.includes('Lancement')) {
    return previewMessagePage(502, 'Aperçu indisponible', `Le runner de ${environmentName} ne connaît pas encore l'aperçu : mettez-le à jour.`);
  }
  const status = response.status === 404 ? 404 : response.status === 409 ? 409 : response.status === 413 ? 413 : 502;
  return previewMessagePage(status, 'Aperçu indisponible', message || 'Le serveur de développement a renvoyé une erreur.');
}

export async function relayPreviewRequest(
  request: Request,
  access: PreviewAccess,
  path: string,
  config: Extract<PreviewConfig, { enabled: true }>,
): Promise<Response> {
  const endpoint = await access.endpoint();
  if (!endpoint.baseUrl || !endpoint.token) return previewMessagePage(503, 'Aperçu indisponible', endpoint.problem ?? runnerUnavailableMessage(endpoint.name));
  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && request.body !== null;
  const url = `${endpoint.baseUrl}${previewRunnerPath(access.runId, path)}`;

  const upstreamAbort = new AbortController();
  const onClientAbort = () => upstreamAbort.abort();
  request.signal.addEventListener('abort', onClientAbort, { once: true });

  const send = async (token: string): Promise<Response> => {
    const timer = setTimeout(() => upstreamAbort.abort(), CONNECT_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method,
        headers: previewRequestHeaders(request.headers, config, token),
        ...(hasBody ? { body: limitedBody(request.body!), duplex: 'half' } : {}),
        redirect: 'manual',
        cache: 'no-store',
        signal: upstreamAbort.signal,
      } as RequestInit);
    } finally {
      clearTimeout(timer);
    }
  };

  let upstream: Response;
  try {
    upstream = await send(endpoint.token);
    // Token rotation in progress (see callRunner); a streamed body cannot be sent twice.
    if (upstream.status === 401 && endpoint.fallbackToken && !hasBody) {
      await upstream.body?.cancel().catch(() => undefined);
      upstream = await send(endpoint.fallbackToken);
      if (upstream.ok) void promoteRunnerToken(endpoint.environmentId, hashToken(endpoint.fallbackToken));
    }
  } catch {
    request.signal.removeEventListener('abort', onClientAbort);
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return previewMessagePage(503, 'Aperçu indisponible', runnerUnavailableMessage(endpoint.name));
  }

  if (upstream.headers.get(PREVIEW_HEADERS.upstream) !== 'upstream') {
    request.signal.removeEventListener('abort', onClientAbort);
    return runnerErrorPage(upstream, endpoint.name);
  }

  const status = upstream.status < 200 || upstream.status > 599 ? 502 : upstream.status;
  const headers = previewResponseHeadersFrom(upstream.headers);
  if (method === 'HEAD' || NO_BODY_STATUS.has(status) || !upstream.body) {
    await upstream.body?.cancel().catch(() => undefined);
    request.signal.removeEventListener('abort', onClientAbort);
    return new Response(null, { status, headers });
  }
  const html = /^text\/html\b/i.test(headers.get('content-type') ?? '') && status === 200;
  const body = html ? injectAfterHead(upstream.body, positionScript(config.appOrigin)) : upstream.body;
  return new Response(body, { status, statusText: upstream.statusText, headers });
}
