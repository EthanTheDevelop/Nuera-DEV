import 'server-only';
import { pickDiagnosticHeaders, type CheckStep } from '@/server/integrations/model';
import { providerMessageOf, sanitizeText } from '@/server/integrations/redact';
import { guardedFetch, SsrfRefusedError } from '@/server/security/ssrf';

/**
 * Non-mutating health probe of a remote MCP server over Streamable HTTP (research §5.6):
 *   initialize → notifications/initialized → tools/list (paginated) → DELETE session.
 * Only `initialize` and `tools/list` are sent: never a tool call. Short timeout (10 s).
 * A server that answers `initialize` with "unsupported protocol version" and lists 2026-07-28 is
 * retried with the modern `server/discover` handshake (dual-era client).
 * The address is chosen by a user: every request goes through the SSRF guard (an internal address
 * ends as `forbidden` with the refusal message), pinned to the checked address, redirects returned.
 */

export const PROBE_CLIENT_INFO = { name: 'nuera-dev-healthcheck', version: '1.0.0' } as const;
export const LEGACY_PROTOCOL_VERSION = '2025-11-25';
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

export type McpProbeOutcome =
  | 'ok'
  | 'unauthorized' // 401 (credential sent or required)
  | 'forbidden' // 403
  | 'not_found' // 404 without JSON-RPC body (MCP disabled / wrong URL)
  | 'protocol_error' // JSON-RPC error or unparsable answer
  | 'server_error'
  | 'timeout'
  | 'network';

export interface McpProbeResult {
  outcome: McpProbeOutcome;
  era: 'legacy' | 'modern' | null;
  protocolVersion: string | null;
  serverInfo: { name: string; version: string | null } | null;
  tools: string[];
  steps: CheckStep[];
  httpStatus: number | null;
  /** Sanitised provider message of the failing step. */
  message: string | null;
  durationMs: number;
}

export interface McpProbeOptions {
  url: string;
  /** Credential + static headers (never logged: steps only keep allow-listed response headers). */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Default: the SSRF-guarded fetch. */
  fetchImpl?: typeof fetch;
  /** Max tools/list pages followed. */
  maxPages?: number;
}

interface RpcAnswer {
  status: number;
  headers: Headers;
  message: unknown;
  ms: number;
}

class ProbeStop extends Error {
  constructor(
    readonly outcome: McpProbeOutcome,
    readonly httpStatus: number | null,
    message: string | null,
  ) {
    super(message ?? outcome);
  }
}

/** Extracts the JSON-RPC message answering `id` from a JSON or SSE body. */
export function parseRpcBody(contentType: string, text: string, id: number | string | null): unknown {
  if (!text.trim()) return null;
  if (contentType.includes('text/event-stream')) {
    const events = text.split(/\r?\n\r?\n/);
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        const message = JSON.parse(data) as { id?: unknown };
        if (id === null || message.id === id) return message;
      } catch {
        // ignore non-JSON events
      }
    }
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.find((item) => (item as { id?: unknown }).id === id) ?? parsed[0] ?? null;
    return parsed;
  } catch {
    return text;
  }
}

/**
 * Reads an SSE answer until the JSON-RPC response with `id` arrived (a server may keep the stream
 * open after answering), then releases the connection.
 */
async function readEventStream(response: Response, id: number | string | null): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < 2_000_000) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (id === null || parseRpcBody('text/event-stream', text, id) !== null) break;
    }
  } catch {
    // aborted (deadline) or reset: keep what was received
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

export async function probeMcpServer(options: McpProbeOptions): Promise<McpProbeResult> {
  const fetchImpl = options.fetchImpl ?? guardedFetch;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const started = performance.now();
  const steps: CheckStep[] = [];
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let era: McpProbeResult['era'] = null;
  let serverInfo: McpProbeResult['serverInfo'] = null;
  const tools: string[] = [];

  async function post(name: string, body: Record<string, unknown>, extra: Record<string, string> = {}): Promise<RpcAnswer> {
    const t0 = performance.now();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(options.headers ?? {}),
      ...extra,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (protocolVersion && !('MCP-Protocol-Version' in extra)) headers['MCP-Protocol-Version'] = protocolVersion;
    let response: Response;
    try {
      response = await fetchImpl(options.url, { method: 'POST', headers, body: JSON.stringify(body), signal: deadline, redirect: 'manual' });
    } catch (error) {
      if (error instanceof SsrfRefusedError) {
        steps.push({ name, ok: false, ms: Math.round(performance.now() - t0), providerMessage: error.message });
        throw new ProbeStop('forbidden', null, error.message);
      }
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      steps.push({ name, ok: false, ms: Math.round(performance.now() - t0), providerMessage: timedOut ? 'délai dépassé' : 'connexion impossible' });
      throw new ProbeStop(timedOut ? 'timeout' : 'network', null, timedOut ? 'Délai dépassé.' : 'Serveur injoignable.');
    }
    const id = 'id' in body ? (body.id as number | string) : null;
    const contentType = response.headers.get('content-type') ?? '';
    const text = contentType.includes('text/event-stream') ? await readEventStream(response, id) : await response.text().catch(() => '');
    const ms = Math.round(performance.now() - t0);
    const message = parseRpcBody(contentType, text, id);
    const headerSummary = pickDiagnosticHeaders(response.headers);
    const ok = response.ok && !(message && typeof message === 'object' && 'error' in message);
    const providerMessage =
      message && typeof message === 'object' && 'error' in message
        ? sanitizeText((message as { error?: { message?: unknown } }).error?.message, 300)
        : response.ok
          ? undefined
          : providerMessageOf(message);
    steps.push({
      name,
      ok,
      ms,
      httpStatus: response.status,
      ...(providerMessage ? { providerMessage } : {}),
      ...(headerSummary ? { headers: headerSummary } : {}),
    });
    return { status: response.status, headers: response.headers, message, ms };
  }

  function stopOnHttp(answer: RpcAnswer): void {
    if (answer.status === 401) throw new ProbeStop('unauthorized', 401, 'Authentification refusée.');
    if (answer.status === 403) throw new ProbeStop('forbidden', 403, providerMessageOf(answer.message) ?? 'Accès refusé.');
    if (answer.status === 404 && !(answer.message && typeof answer.message === 'object' && 'jsonrpc' in answer.message)) {
      throw new ProbeStop('not_found', 404, "Point d'accès MCP introuvable.");
    }
    if (answer.status >= 500) throw new ProbeStop('server_error', answer.status, 'Erreur du serveur MCP.');
  }

  function rpcResult(answer: RpcAnswer): Record<string, unknown> {
    const message = answer.message as { result?: unknown; error?: { message?: unknown } } | null;
    if (!message || typeof message !== 'object' || !('result' in message) || !message.result || typeof message.result !== 'object') {
      throw new ProbeStop(
        'protocol_error',
        answer.status,
        sanitizeText(message?.error?.message, 300) ?? 'Réponse MCP inattendue.',
      );
    }
    return message.result as Record<string, unknown>;
  }

  async function listTools(): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < (options.maxPages ?? 5); page += 1) {
      const answer = await post(page === 0 ? 'POST tools/list' : `POST tools/list (page ${page + 1})`, {
        jsonrpc: '2.0',
        id: 10 + page,
        method: 'tools/list',
        params: cursor ? { cursor } : {},
      }, era === 'modern' ? { 'Mcp-Method': 'tools/list', 'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION } : {});
      stopOnHttp(answer);
      const result = rpcResult(answer);
      const list = Array.isArray(result.tools) ? result.tools : [];
      for (const tool of list) {
        if (tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string') {
          tools.push((tool as { name: string }).name);
        }
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
  }

  let outcome: McpProbeOutcome = 'ok';
  let httpStatus: number | null = null;
  let message: string | null = null;
  try {
    const init = await post('POST initialize', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: PROBE_CLIENT_INFO },
    });
    stopOnHttp(init);
    httpStatus = init.status;
    const initMessage = init.message as { error?: { code?: number; data?: { supported?: unknown } } } | null;
    const supported = initMessage?.error?.data?.supported;
    if (
      initMessage?.error &&
      Array.isArray(supported) &&
      supported.includes(MODERN_PROTOCOL_VERSION) &&
      !supported.includes(LEGACY_PROTOCOL_VERSION)
    ) {
      // Modern-only server (2026-07-28): stateless discover + tools/list.
      era = 'modern';
      const discover = await post(
        'POST server/discover',
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'server/discover',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
              'io.modelcontextprotocol/clientInfo': PROBE_CLIENT_INFO,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        },
        { 'Mcp-Method': 'server/discover', 'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION },
      );
      stopOnHttp(discover);
      const result = rpcResult(discover);
      protocolVersion = MODERN_PROTOCOL_VERSION;
      const meta = (result._meta ?? {}) as Record<string, unknown>;
      const info = meta['io.modelcontextprotocol/serverInfo'] as { name?: unknown; version?: unknown } | undefined;
      if (info && typeof info.name === 'string') serverInfo = { name: info.name, version: typeof info.version === 'string' ? info.version : null };
    } else {
      const result = rpcResult(init);
      era = 'legacy';
      protocolVersion = typeof result.protocolVersion === 'string' ? result.protocolVersion : LEGACY_PROTOCOL_VERSION;
      const info = result.serverInfo as { name?: unknown; version?: unknown } | undefined;
      if (info && typeof info.name === 'string') serverInfo = { name: info.name, version: typeof info.version === 'string' ? info.version : null };
      sessionId = init.headers.get('mcp-session-id');
      const initialized = await post('POST notifications/initialized', { jsonrpc: '2.0', method: 'notifications/initialized' });
      stopOnHttp(initialized);
    }
    await listTools();
  } catch (error) {
    if (error instanceof ProbeStop) {
      outcome = error.outcome;
      httpStatus = error.httpStatus;
      message = error.message;
    } else {
      outcome = 'protocol_error';
      message = 'Réponse MCP inattendue.';
    }
  } finally {
    if (sessionId) {
      // End the session; 405 is acceptable (server-managed sessions).
      await fetchImpl(options.url, {
        method: 'DELETE',
        headers: { ...(options.headers ?? {}), 'Mcp-Session-Id': sessionId, ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}) },
        signal: AbortSignal.timeout(3_000),
        // Like every probe request: never carry the credential headers to another location.
        redirect: 'manual',
      })
        .then((response) => response.body?.cancel())
        .catch(() => undefined);
    }
  }
  return {
    outcome,
    era,
    protocolVersion,
    serverInfo,
    tools,
    steps,
    httpStatus,
    message,
    durationMs: Math.round(performance.now() - started),
  };
}

/**
 * Unauthenticated reachability probe of an OAuth MCP server (Figma): a 401 with
 * `WWW-Authenticate: Bearer resource_metadata=…` proves the endpoint is up and requires OAuth.
 */
export async function probeOAuthEndpoint(url: string, options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<CheckStep & { reachable: boolean }> {
  const fetchImpl = options.fetchImpl ?? guardedFetch;
  const t0 = performance.now();
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: PROBE_CLIENT_INFO },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
      redirect: 'manual',
    });
    await response.body?.cancel().catch(() => undefined);
    const headers = pickDiagnosticHeaders(response.headers);
    const reachable = response.status === 401 || response.ok;
    return {
      name: 'POST initialize (sans authentification)',
      ok: reachable,
      ms: Math.round(performance.now() - t0),
      httpStatus: response.status,
      ...(headers ? { headers } : {}),
      reachable,
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      name: 'POST initialize (sans authentification)',
      ok: false,
      ms: Math.round(performance.now() - t0),
      providerMessage: error instanceof SsrfRefusedError ? error.message : timedOut ? 'délai dépassé' : 'connexion impossible',
      reachable: false,
    };
  }
}
