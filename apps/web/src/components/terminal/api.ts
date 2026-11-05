/**
 * Browser calls of the terminal routes (same origin, session cookie). Errors carry the French
 * message of the API body (`{ error: { code, message, detail?, raw?, untouched? } }`).
 *
 *   const terminal = await createTerminal({ kind: 'claude-status' });         // POST /api/terminals
 *   const { terminalId } = await startMcpLoginTerminal('figma');             // POST /api/integrations/mcp/figma/login
 *   await closeTerminalRequest(terminal.id, { keepalive: true });             // DELETE /api/terminals/<id>
 */

import type { TerminalDto } from '@nuera/shared/runner';

export type CreateTerminalBody =
  | { kind: 'shell'; worktreeId: string; cols?: number; rows?: number }
  | { kind: 'claude-login'; cols?: number; rows?: number }
  | { kind: 'claude-status'; cols?: number; rows?: number };

export class TerminalApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly detail?: string;
  readonly raw?: string;
  readonly untouched?: string;

  constructor(status: number, code: string | null, message: string, extra: { detail?: string; raw?: string; untouched?: string } = {}) {
    super(message);
    this.name = 'TerminalApiError';
    this.status = status;
    this.code = code;
    if (extra.detail) this.detail = extra.detail;
    if (extra.raw) this.raw = extra.raw;
    if (extra.untouched) this.untouched = extra.untouched;
  }
}

export const terminalUrls = (terminalId: string) => {
  const id = encodeURIComponent(terminalId);
  return {
    stream: `/api/stream/terminals/${id}`,
    input: `/api/terminals/${id}/input`,
    resize: `/api/terminals/${id}/resize`,
    info: `/api/terminals/${id}`,
  };
};

const NETWORK_MESSAGE = 'Le serveur web ne répond pas : vérifiez la connexion, puis réessayez.';

interface ErrorBodyLike {
  error?: { code?: unknown; message?: unknown; detail?: unknown; raw?: unknown; untouched?: unknown };
}

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
    throw new TerminalApiError(0, 'NETWORK', NETWORK_MESSAGE);
  }
  if (!response.ok) {
    let body: ErrorBodyLike | null;
    try {
      body = (await response.json()) as ErrorBodyLike | null;
    } catch {
      body = null;
    }
    const error = body?.error;
    const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    throw new TerminalApiError(response.status, str(error?.code) ?? null, str(error?.message) ?? fallbackMessage, {
      ...(str(error?.detail) ? { detail: str(error?.detail) } : {}),
      ...(str(error?.raw) ? { raw: str(error?.raw) } : {}),
      ...(str(error?.untouched) ? { untouched: str(error?.untouched) } : {}),
    });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** POST /api/terminals → the new terminal (shell, claude-login, claude-status). */
export async function createTerminal(body: CreateTerminalBody): Promise<TerminalDto> {
  const result = await call<{ terminal: TerminalDto }>(
    '/api/terminals',
    { method: 'POST', body: JSON.stringify(body) },
    "Le terminal n'a pas pu s'ouvrir.",
  );
  return result.terminal;
}

/** GET /api/terminals/[id]. */
export async function fetchTerminal(terminalId: string): Promise<TerminalDto> {
  const result = await call<{ terminal: TerminalDto }>(terminalUrls(terminalId).info, { method: 'GET' }, 'Terminal introuvable.');
  return result.terminal;
}

/** DELETE /api/terminals/[id] (idempotent). `keepalive` lets it leave while the page unloads. */
export async function closeTerminalRequest(terminalId: string, options: { keepalive?: boolean } = {}): Promise<void> {
  await call<void>(terminalUrls(terminalId).info, { method: 'DELETE', keepalive: options.keepalive ?? false }, "Le terminal n'a pas pu être fermé.");
}

/** POST /api/integrations/mcp/[server]/login (Intégrations « Reconnecter » an OAuth MCP server). */
export async function startMcpLoginTerminal(serverName: string): Promise<{ terminalId: string; title: string }> {
  const result = await call<{ terminalId: string; title: string }>(
    `/api/integrations/mcp/${encodeURIComponent(serverName)}/login`,
    { method: 'POST' },
    "La connexion du serveur MCP n'a pas pu démarrer.",
  );
  return { terminalId: result.terminalId, title: result.title };
}

/** Fire-and-forget POST used by the view for keystrokes and resizes (throws TerminalApiError). */
export async function postTerminalJson(url: string, body: unknown, options: { keepalive?: boolean } = {}): Promise<void> {
  await call<void>(url, { method: 'POST', body: JSON.stringify(body), keepalive: options.keepalive ?? false }, 'Le terminal ne répond pas.');
}
