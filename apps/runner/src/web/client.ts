import { z } from 'zod';
import { GitExtraHeaderSchema } from '@nuera/shared/runner';
import type { Logger } from 'pino';

/**
 * Runner → web callbacks (`/api/internal/*`, Bearer RUNNER_TOKEN = the token of this runner's
 * server: the web derives the server from it and refuses any project or session outside it).
 * Every call tolerates an unreachable web app or a 404 (endpoint not deployed yet): it returns
 * null and the runner carries on.
 */

export interface NotifyPayload {
  kind:
    | 'permission_request'
    | 'session_finished'
    | 'session_failed'
    | 'session_interrupted'
    | 'session_usage_limit'
    | 'session_auto_resumed'
    | 'operation_failed'
    | 'operation_succeeded'
    | 'claude_disconnected'
    | 'server';
  severity: 'info' | 'success' | 'warning' | 'danger';
  title: string;
  body?: string | null;
  href?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  /** One unread notification per key (e.g. `permission:<id>`). */
  dedupKey?: string | null;
}

const NotifyResponseSchema = z
  .object({ id: z.string().optional(), notification: z.object({ id: z.string() }).partial().optional() })
  .passthrough();
const HeadersResponseSchema = z.object({ headers: z.record(z.string(), z.string()) });
// Same check as the extraHeader of a request: it goes into the env of a git process.
const GitCredentialsResponseSchema = z.object({ extraHeader: GitExtraHeaderSchema, expiresAt: z.string().optional() });

export class WebClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly logger: Logger,
  ) {}

  private async post(path: string, body: unknown, timeoutMs: number): Promise<unknown | null> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) {
        this.logger.debug({ path }, 'callback web absent (404)');
        return null;
      }
      if (response.status === 401 || response.status === 403) {
        this.logger.warn({ path, status: response.status }, 'Le web refuse le jeton de ce serveur (révoqué, renouvelé ou serveur suspendu ?) : rappel ignoré.');
        return null;
      }
      if (!response.ok) {
        this.logger.warn({ path, status: response.status }, 'callback web refusé');
        return null;
      }
      const text = await response.text();
      return text ? (JSON.parse(text) as unknown) : {};
    } catch (error) {
      this.logger.debug({ path, err: (error as Error).message }, 'web injoignable');
      return null;
    }
  }

  /** Creates a notification (centre + Web Push). Returns its id when the web gives one. */
  async notify(payload: NotifyPayload): Promise<{ id: string | null } | null> {
    const clamp = (text: string | null | undefined, max: number) => (text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : text);
    const body = { ...payload, title: clamp(payload.title, 200) ?? payload.title, body: clamp(payload.body ?? null, 1000) };
    const raw = await this.post('/api/internal/notify', body, 5000);
    if (raw === null) return null;
    const parsed = NotifyResponseSchema.safeParse(raw);
    return { id: parsed.success ? (parsed.data.id ?? parsed.data.notification?.id ?? null) : null };
  }

  /** Headers for an MCP server of a session (headersHelper). Null = refused or unavailable. */
  async mcpHeaders(payload: { sessionId: string; projectId: string; serverName: string; serverUrl: string | null }): Promise<Record<string, string> | null> {
    const raw = await this.post('/api/internal/mcp-headers', payload, 8000);
    const parsed = HeadersResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data.headers : null;
  }

  /**
   * Effective common Claude configuration of this server (rules, skills). The files of the skills
   * listed in `have` are omitted when unchanged. Null = refused, unavailable or not deployed.
   */
  async claudeConfig(have: Array<{ name: string; hash: string }>): Promise<unknown | null> {
    return this.post('/api/internal/claude-config', { have }, 30_000);
  }

  /** Read token header for a background fetch. */
  async gitCredentials(payload: { projectId: string; fullName: string; access: 'read' }): Promise<{ extraHeader: string } | null> {
    const raw = await this.post('/api/internal/git-credentials', payload, 10_000);
    const parsed = GitCredentialsResponseSchema.safeParse(raw);
    return parsed.success ? { extraHeader: parsed.data.extraHeader } : null;
  }
}
