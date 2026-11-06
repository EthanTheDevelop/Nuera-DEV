import 'server-only';
import { randomUUID } from 'node:crypto';
import type { IntegrationStatus, McpStatus } from '@nuera/db/schema';

/**
 * Shared vocabulary of every integration check (GitHub App, Coolify, MCP servers).
 * docs/research/integrations.md §7.2 (status model) and §7.3 (diagnostic « Voir le journal »).
 *
 * Status values are the DB unions (packages/db/src/schema/types.ts):
 *   integrations.status : pending | connected | expiring | expired | error | disconnected
 *   mcp_servers.status  : connected | needs_auth | expired | error | disabled | unknown
 */

export type CheckTrigger = 'schedule' | 'manual' | 'hook' | 'git_failure' | 'startup' | 'setup';

export interface CheckStep {
  /** "GET /app", "POST /mcp initialize", "claude mcp get figma"… */
  name: string;
  ok: boolean;
  ms: number;
  httpStatus?: number;
  /** Sanitised provider message (« Unauthenticated. »). Never a secret. */
  providerMessage?: string;
  /** Allow-listed response headers only (rate limit, request id, www-authenticate…). */
  headers?: Record<string, string>;
  /** Redacted raw output (CLI, stderr), shown « à un clic ». */
  raw?: string;
}

export interface CheckAction {
  /** French label of the suggested action (« Réautoriser sur GitHub »). */
  label: string;
  kind: 'external' | 'terminal' | 'form' | 'internal';
  url?: string;
}

export interface CheckResult<TStatus extends string = string> {
  status: TStatus;
  /** French, user-facing reason (« Application non installée »). */
  reason?: string;
  action?: CheckAction;
}

export interface IntegrationCheck<TStatus extends string = string> {
  id: string;
  /** `github:<sourceId>` (historically 'github') | 'github:fallback' | 'coolify' | `mcp:${name}` */
  target: string;
  trigger: CheckTrigger;
  startedAt: string;
  durationMs: number;
  steps: CheckStep[];
  result: CheckResult<TStatus>;
}

/** Compact entry kept in the history of a target (newest first). */
export interface CheckHistoryEntry {
  at: string;
  trigger: CheckTrigger;
  status: string;
  reason?: string;
  durationMs: number;
}

export const CHECK_HISTORY_LIMIT = 20;
export const CHECK_INTERVAL_MINUTES = 15;
/** A known expiry closer than this turns a connected integration into « bientôt expirée » (T7 avant). */
export const EXPIRING_THRESHOLD_MS = 7 * 24 * 3600_000;

export type { IntegrationStatus, McpStatus };

export function newCheckId(): string {
  return randomUUID();
}

/** Small stopwatch used to build check steps. */
export function startTimer(): () => number {
  const started = performance.now();
  return () => Math.round(performance.now() - started);
}

export function historyEntry(check: IntegrationCheck): CheckHistoryEntry {
  return {
    at: check.startedAt,
    trigger: check.trigger,
    status: check.result.status,
    ...(check.result.reason ? { reason: check.result.reason } : {}),
    durationMs: check.durationMs,
  };
}

export function pushHistory(history: CheckHistoryEntry[] | undefined, check: IntegrationCheck): CheckHistoryEntry[] {
  return [historyEntry(check), ...(history ?? [])].slice(0, CHECK_HISTORY_LIMIT);
}

/** Badge vocabulary shared by D07 / D01 / M07 (Figma copy). */
export const STATUS_BADGES: Record<IntegrationStatus | McpStatus, { label: string; tone: 'success' | 'danger' | 'warn' | 'neutral' }> = {
  connected: { label: 'Connecté', tone: 'success' },
  expiring: { label: 'Connecté', tone: 'success' },
  expired: { label: 'Autorisation expirée', tone: 'danger' },
  needs_auth: { label: 'Connexion requise', tone: 'warn' },
  error: { label: 'Injoignable', tone: 'danger' },
  disabled: { label: 'Désactivé', tone: 'neutral' },
  disconnected: { label: 'Non connecté', tone: 'neutral' },
  pending: { label: 'Non vérifié', tone: 'neutral' },
  unknown: { label: 'Non vérifié', tone: 'neutral' },
};

/**
 * Hysteresis (research §7.2): a definitive credential refusal is applied at once, a transient
 * failure (network, timeout, 5xx) only after two consecutive failed checks, so the UI does not flap.
 */
export function applyHysteresis<T extends string>(input: {
  previous: T;
  next: T;
  transient: boolean;
  consecutiveFailures: number;
}): T {
  if (!input.transient) return input.next;
  return input.consecutiveFailures >= 2 ? input.next : input.previous;
}

/** Allow-listed response headers recorded in diagnostics. */
const DIAGNOSTIC_HEADERS = [
  'x-github-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'retry-after',
  'mcp-protocol-version',
] as const;

export function pickDiagnosticHeaders(headers: Headers | Record<string, string | undefined>): Record<string, string> | undefined {
  const get = (name: string): string | undefined =>
    headers instanceof Headers ? (headers.get(name) ?? undefined) : headers[name];
  const out: Record<string, string> = {};
  for (const name of DIAGNOSTIC_HEADERS) {
    const value = get(name);
    if (value) out[name] = value.slice(0, 200);
  }
  const wwwAuthenticate = get('www-authenticate');
  if (wwwAuthenticate) {
    // Keep only the parts that help to diagnose (resource metadata URL and scope), never a token.
    const kept = [...wwwAuthenticate.matchAll(/(resource_metadata|scope|error)="([^"]{0,300})"/g)].map(
      (m) => `${m[1]}="${m[2]}"`,
    );
    out['www-authenticate'] = kept.length ? `Bearer ${kept.join(', ')}` : 'Bearer';
  }
  return Object.keys(out).length ? out : undefined;
}
