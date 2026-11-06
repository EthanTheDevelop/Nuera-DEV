import 'server-only';
import {
  connectionListedHeaders,
  HOP_BY_HOP_HEADERS,
  isSafePreviewPath,
  PREVIEW_HEADERS,
  PREVIEW_LIMITS,
  previewRunnerPath,
  stripNueraCookies,
} from '@nuera/shared/runner';
import { hashToken } from '@nuera/shared/tokens';
import type { PreviewConfig } from '@/lib/preview';
import { promoteRunnerToken } from '@/server/admin/token-rotation';
import { runnerUnavailableMessage, type RunnerEndpoint } from '@/server/runner/client';
import { PreviewDenied, resolvePreviewAccess } from './access';
import { previewMessagePage } from './html';
import { readPreviewCookie } from './tokens';

/**
 * Every request of the preview host but the entry (`src/proxy.ts`): cookie `nuera_apercu` → access
 * re-checked (`resolvePreviewAccess`) → the runner of the run's server, reached by a Next.js
 * EXTERNAL rewrite to `/v1/runs/<id>/preview<path>` (« direct » mode, `@nuera/shared/runner`
 * preview.ts). Next itself then streams the request and the answer (WebSocket upgrades included)
 * without ever handling them as its own: an RSC request of a previewed Next.js site is not
 * validated, redirected or re-headed by Nuera Dev's Next (it used to loop on `?_rsc=` and announce
 * `x-nextjs-rewritten-path: /api/apercu/proxy`), and the dev server's hot-reload socket works
 * (`next dev` does not hydrate without it and reloads the page in a loop).
 *
 * Browser → runner: hop-by-hop fields (but the WebSocket handshake), `Host`, Nuera Dev's cookies
 * and internal headers dropped; the browser's own `Authorization` travels in
 * `x-nuera-preview-authorization` (the hop's one is the runner token, never seen by the browser:
 * request headers set by the proxy stay on the server). A refusal is the short French page.
 */

const HOP = new Set<string>(HOP_BY_HOP_HEADERS);
const DROPPED = /^(?:host|cookie|authorization|accept-encoding|expect|forwarded|via|x-real-ip|x-forwarded-.*|x-middleware-.*|x-invoke-.*|x-nuera-.*|x-matched-path)$/i;
const PROBE_TTL_MS = 5_000;
const PROBE_TIMEOUT_MS = 3_000;

const CLOSED_TITLE = 'Aperçu fermé';
const CLOSED_TEXT = "Ouvrez l'aperçu depuis le Workspace de Nuera Dev.";
const UNAVAILABLE = 'Aperçu indisponible';

export type PreviewGateResult = { kind: 'rewrite'; url: string; headers: Headers } | { kind: 'response'; response: Response };

export function isWebSocketUpgrade(headers: Headers): boolean {
  return (headers.get('upgrade') ?? '').toLowerCase() === 'websocket';
}

/** Headers of the hop to the runner (see the module comment). */
export function previewHopHeaders(source: Headers, config: Extract<PreviewConfig, { enabled: true }>, token: string): Headers {
  const websocket = isWebSocketUpgrade(source);
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
  const length = out.get('content-length');
  if (length !== null && !/^\d{1,12}$/.test(length)) out.delete('content-length');
  if (websocket) {
    out.set('connection', 'Upgrade');
    out.set('upgrade', 'websocket');
  }
  out.set(PREVIEW_HEADERS.origin, config.origin);
  out.set(PREVIEW_HEADERS.appOrigin, config.appOrigin);
  out.set('authorization', `Bearer ${token}`);
  return out;
}

// --- Runner reachability (a refused connection would otherwise end as Next's bare « Internal Server Error »)

type Probe = 'ok' | 'unauthorized' | 'down';
const holder = globalThis as unknown as { __nueraPreviewProbes?: Map<string, number> };
function probes(): Map<string, number> {
  holder.__nueraPreviewProbes ??= new Map();
  return holder.__nueraPreviewProbes;
}

/** Forgets the reachability verdicts (tests). */
export function resetPreviewProbes(): void {
  probes().clear();
}

async function probe(baseUrl: string, token: string): Promise<Probe> {
  const key = `${baseUrl}\u0000${hashToken(token)}`;
  if ((probes().get(key) ?? 0) > Date.now()) return 'ok';
  try {
    const response = await fetch(`${baseUrl}/v1/health`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) return 'unauthorized';
    probes().set(key, Date.now() + PROBE_TTL_MS);
    return 'ok';
  } catch {
    return 'down';
  }
}

/** Token the runner accepts (current one, else the one of a rotation in progress), or why none. */
async function usableToken(endpoint: RunnerEndpoint): Promise<{ token: string } | { problem: string }> {
  if (!endpoint.baseUrl || !endpoint.token) return { problem: endpoint.problem ?? runnerUnavailableMessage(endpoint.name) };
  const first = await probe(endpoint.baseUrl, endpoint.token);
  if (first === 'ok') return { token: endpoint.token };
  if (first === 'unauthorized' && endpoint.fallbackToken && (await probe(endpoint.baseUrl, endpoint.fallbackToken)) === 'ok') {
    void promoteRunnerToken(endpoint.environmentId, hashToken(endpoint.fallbackToken));
    return { token: endpoint.fallbackToken };
  }
  return { problem: runnerUnavailableMessage(endpoint.name) };
}

const page = (status: number, title: string, message: string): PreviewGateResult => ({ kind: 'response', response: previewMessagePage(status, title, message) });

/**
 * Decision for one request of the preview host: the runner URL + headers of the external rewrite,
 * or the page that answers instead. `pathAndQuery` is the raw path of the browser's request.
 */
export async function previewGate(
  request: { headers: Headers; cookie: string | undefined },
  pathAndQuery: string,
  config: Extract<PreviewConfig, { enabled: true }>,
): Promise<PreviewGateResult> {
  if (!isSafePreviewPath(pathAndQuery)) return page(400, 'Adresse refusée', 'Ce chemin ne peut pas être transmis au serveur de développement.');
  const claims = readPreviewCookie(request.cookie);
  if (!claims) return page(401, CLOSED_TITLE, CLOSED_TEXT);
  // A WebSocket opened by another site would carry the cookie (SameSite=None in tests): own origin only.
  if (isWebSocketUpgrade(request.headers) && request.headers.get('origin') !== config.origin) return page(403, CLOSED_TITLE, CLOSED_TEXT);
  let access: Awaited<ReturnType<typeof resolvePreviewAccess>>;
  try {
    access = await resolvePreviewAccess(claims);
  } catch (error) {
    if (error instanceof PreviewDenied) return page(403, CLOSED_TITLE, error.message);
    throw error;
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > PREVIEW_LIMITS.requestBodyBytes) {
    return page(413, 'Envoi trop volumineux', "L'aperçu transmet au plus 10 Mo par requête.");
  }
  const endpoint = await access.endpoint();
  const usable = await usableToken(endpoint);
  if ('problem' in usable) return page(503, UNAVAILABLE, usable.problem);
  return {
    kind: 'rewrite',
    url: `${endpoint.baseUrl}${previewRunnerPath(access.runId, pathAndQuery)}`,
    headers: previewHopHeaders(request.headers, config, usable.token),
  };
}

