/**
 * Browser calls of the session routes (same origin, session cookie). Errors carry the French
 * message of the API body (`{ error: { code, message, detail?, raw?, untouched? } }`) for the T4 panel.
 *
 *   const { sessionId, workspaceUrl } = await createSessionRequest(input);   // POST /api/sessions
 *   await resumeSessionRequest(id);  await stopSessionRequest(id);           // POST …/resume, …/stop
 *   await archiveSessionRequest(id); await renameSessionRequest(id, title);   // DELETE / PATCH …/[id]
 */
import type {
  CreateSessionInput,
  CreateSessionResult,
  HistoryFilter,
  HistoryPeriod,
  SessionListItem,
  SessionListPage,
  SessionSummary,
} from './lib/contract';

export class SessionApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly detail?: string;
  readonly raw?: string;
  readonly untouched?: string;

  constructor(status: number, code: string | null, message: string, extra: { detail?: string; raw?: string; untouched?: string } = {}) {
    super(message);
    this.name = 'SessionApiError';
    this.status = status;
    this.code = code;
    if (extra.detail) this.detail = extra.detail;
    if (extra.raw) this.raw = extra.raw;
    if (extra.untouched) this.untouched = extra.untouched;
  }
}

export const NETWORK_MESSAGE = 'Le serveur web ne répond pas : vérifiez la connexion, puis réessayez.';

interface ErrorBodyLike {
  error?: { code?: unknown; message?: unknown; detail?: unknown; raw?: unknown; untouched?: unknown };
}

const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

async function call<T>(url: string, init: RequestInit, fallbackMessage: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    throw new SessionApiError(0, 'NETWORK', NETWORK_MESSAGE);
  }
  if (!response.ok) {
    let body: ErrorBodyLike | null;
    try {
      body = (await response.json()) as ErrorBodyLike | null;
    } catch {
      body = null;
    }
    const error = body?.error;
    throw new SessionApiError(response.status, str(error?.code) ?? null, str(error?.message) ?? fallbackMessage, {
      ...(str(error?.detail) ? { detail: str(error?.detail) } : {}),
      ...(str(error?.raw) ? { raw: str(error?.raw) } : {}),
      ...(str(error?.untouched) ? { untouched: str(error?.untouched) } : {}),
    });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const sessionUrl = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}`;

export interface SessionActionResponse {
  session: SessionListItem;
  workspaceUrl: string;
}

export function createSessionRequest(input: CreateSessionInput): Promise<CreateSessionResult> {
  return call('/api/sessions', { method: 'POST', body: JSON.stringify(input) }, "La session n'a pas pu être créée.");
}

export function resumeSessionRequest(sessionId: string): Promise<SessionActionResponse> {
  return call(`${sessionUrl(sessionId)}/resume`, { method: 'POST' }, "La session n'a pas pu être reprise.");
}

export function stopSessionRequest(sessionId: string, options: { force?: boolean } = {}): Promise<SessionActionResponse> {
  return call(
    `${sessionUrl(sessionId)}/stop`,
    { method: 'POST', body: JSON.stringify(options.force ? { force: true } : {}) },
    "La session n'a pas pu être arrêtée.",
  );
}

export function archiveSessionRequest(sessionId: string): Promise<SessionActionResponse> {
  return call(sessionUrl(sessionId), { method: 'DELETE' }, "La session n'a pas pu être archivée.");
}

export function renameSessionRequest(sessionId: string, title: string): Promise<SessionActionResponse> {
  return call(sessionUrl(sessionId), { method: 'PATCH', body: JSON.stringify({ title }) }, "La session n'a pas pu être renommée.");
}

export function fetchSessionSummary(sessionId: string, signal?: AbortSignal): Promise<SessionSummary> {
  return call(sessionUrl(sessionId), { method: 'GET', ...(signal ? { signal } : {}) }, 'Le résumé de la session est indisponible.');
}

export interface HistoryRequest {
  filter: HistoryFilter;
  period: HistoryPeriod;
  projectId?: string | null;
  q?: string;
  cursor?: string | null;
  limit?: number;
}

export function fetchHistoryPage(input: HistoryRequest, signal?: AbortSignal): Promise<SessionListPage> {
  const params = new URLSearchParams({ statut: 'history', filtre: input.filter, periode: input.period });
  if (input.projectId) params.set('projet', input.projectId);
  if (input.q) params.set('q', input.q);
  if (input.cursor) params.set('curseur', input.cursor);
  if (input.limit) params.set('limite', String(input.limit));
  return call(`/api/sessions?${params.toString()}`, { method: 'GET', ...(signal ? { signal } : {}) }, "L'historique n'a pas pu être chargé.");
}

export function fetchActiveSessions(signal?: AbortSignal): Promise<SessionListPage> {
  return call('/api/sessions?statut=active', { method: 'GET', ...(signal ? { signal } : {}) }, 'Les sessions en cours sont indisponibles.');
}
