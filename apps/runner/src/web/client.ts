import { z } from 'zod';
import { GitExtraHeaderSchema } from '@nuera/shared/runner';
import type { Logger } from 'pino';

/**
 * Runner → web callbacks (`/api/internal/*`, Bearer RUNNER_TOKEN, implemented by the web app).
 * Every call tolerates an unreachable web app or a 404 (endpoint not deployed yet): it returns
 * null and the runner carries on.
 */

export interface NotifyPayload {
  kind:
    | 'permission_request'
    | 'session_finished'
    | 'session_failed'
    | 'session_interrupted'
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

  /** Read token header for a background fetch. */
  async gitCredentials(payload: { projectId: string; fullName: string; access: 'read' }): Promise<{ extraHeader: string } | null> {
    const raw = await this.post('/api/internal/git-credentials', payload, 10_000);
    const parsed = GitCredentialsResponseSchema.safeParse(raw);
    return parsed.success ? { extraHeader: parsed.data.extraHeader } : null;
  }

  /** Asks the web to run its integration checks (every 15 min). */
  async integrationsCheck(trigger: 'schedule' | 'startup' = 'schedule'): Promise<boolean> {
    return (await this.post('/api/internal/integrations/check', { trigger }, 120_000)) !== null;
  }
}
