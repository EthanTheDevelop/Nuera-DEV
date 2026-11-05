/**
 * Browser calls of the existing integration routes (`/api/integrations/**`, same origin, session
 * cookie, Origin checked by `apiRoute` on mutations). Errors carry the French message of the API
 * body plus `detail`, `untouched` and `raw` for the T4 panels. Nothing secret ever comes back.
 */
import type { AccessibleReposResult, CoolifyReconnectResult, GithubStatus, McpServerView } from './types';

export class IntegrationsApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly detail?: string;
  readonly raw?: string;
  readonly untouched?: string;

  constructor(status: number, code: string | null, message: string, extra: { detail?: string; raw?: string; untouched?: string } = {}) {
    super(message);
    this.name = 'IntegrationsApiError';
    this.status = status;
    this.code = code;
    if (extra.detail) this.detail = extra.detail;
    if (extra.raw) this.raw = extra.raw;
    if (extra.untouched) this.untouched = extra.untouched;
  }
}

export const NETWORK_MESSAGE = 'Le serveur web ne répond pas : vérifiez la connexion, puis réessayez.';

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export async function integrationsFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    throw new IntegrationsApiError(0, 'NETWORK', NETWORK_MESSAGE);
  }
  if (!response.ok) {
    let body: { error?: Record<string, unknown> } | null = null;
    try {
      body = (await response.json()) as { error?: Record<string, unknown> };
    } catch {
      body = null;
    }
    const error = body?.error ?? {};
    const detail = text(error.detail);
    const raw = text(error.raw);
    const untouched = text(error.untouched);
    throw new IntegrationsApiError(response.status, text(error.code) ?? null, text(error.message) ?? `Erreur ${response.status}.`, {
      ...(detail ? { detail } : {}),
      ...(raw ? { raw } : {}),
      ...(untouched ? { untouched } : {}),
    });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Any thrown value → the error shape used by the panels. */
export function toApiError(error: unknown): IntegrationsApiError {
  if (error instanceof IntegrationsApiError) return error;
  return new IntegrationsApiError(0, 'INTERNAL', error instanceof Error && error.message ? error.message : 'Erreur inattendue.');
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const server = (name: string) => `/api/integrations/mcp/${encodeURIComponent(name)}`;

export interface CreateMcpServerBody {
  name: string;
  label: string;
  description?: string | null;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  authKind?: 'none' | 'bearer' | 'header' | 'oauth';
  bearerToken?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
}

export interface ReconnectCoolifyBody {
  token: string;
  baseUrl?: string;
  expiresAt?: string | null;
}

export const integrationsApi = {
  /** « Vérifier la connexion » (D07 / M07). */
  checkGithub: () => integrationsFetch<GithubStatus>('/api/integrations/github/check', { method: 'POST' }),
  /** « Voir les N dépôts ». */
  githubRepos: (signal?: AbortSignal) => integrationsFetch<AccessibleReposResult>('/api/integrations/github/repos', signal ? { signal } : {}),
  getMcpServer: (name: string, signal?: AbortSignal) => integrationsFetch<McpServerView>(server(name), signal ? { signal } : {}),
  /** « Tester la connexion » (D1). */
  checkMcpServer: (name: string) => integrationsFetch<McpServerView>(`${server(name)}/check`, { method: 'POST' }),
  /** « ACTIVÉ DANS » switch. */
  setProjectEnabled: (name: string, projectId: string, enabled: boolean) =>
    integrationsFetch<McpServerView>(`${server(name)}/projects/${encodeURIComponent(projectId)}`, { method: 'PUT', ...json({ enabled }) }),
  /** « Désactiver partout » (confirmed by T8). */
  disableEverywhere: (name: string) =>
    integrationsFetch<{ server: McpServerView; disabledProjects: number }>(`${server(name)}/disable-all`, { method: 'POST' }),
  /** « Ajouter un serveur MCP ». */
  createMcpServer: (body: CreateMcpServerBody) =>
    integrationsFetch<{ server: McpServerView }>('/api/integrations/mcp', { method: 'POST', ...json(body) }),
  /** Replaces the secret headers of a custom server (never read back). */
  replaceMcpSecret: (name: string, body: { bearerToken: string } | { headers: Record<string, string> }) =>
    integrationsFetch<McpServerView>(server(name), { method: 'PATCH', ...json(body) }),
  deleteMcpServer: (name: string) => integrationsFetch<{ deleted: string }>(server(name), { method: 'DELETE' }),
  /** D2 « Reconnecter » (Coolify token, validated with GET calls only). */
  reconnectCoolify: (body: ReconnectCoolifyBody) =>
    integrationsFetch<CoolifyReconnectResult>('/api/integrations/coolify', { method: 'PUT', ...json(body) }),
};
