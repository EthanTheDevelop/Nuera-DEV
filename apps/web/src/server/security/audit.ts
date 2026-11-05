import 'server-only';
import { auditLog } from '@nuera/db/schema';
import { and, desc, eq, inArray, like, lt, or, type SQL } from 'drizzle-orm';
import { db } from '@/server/db';
import { getClientIp, getUserAgent } from '@/server/security/request-info';

/**
 * Security journal (« Journal de sécurité ») and sensitive actions — table `audit_log`.
 *
 *   await audit({ action: 'git.push', summary: 'push de crm-core vers origin · Nuera OS',
 *                 targetType: 'project', targetId: project.id, actorUserId: user.id });
 *
 * - `summary` is the short French line shown in the journal, after the date
 *   (« connexion depuis un nouvel appareil (Lyon) », « codes de secours régénérés »).
 * - IP and user agent are captured from the current request (next/headers) when available.
 * - Metadata keys that look like secrets are dropped; never pass secret values anyway.
 * - Never throws: a failure is logged on the server and the calling action goes on.
 *
 * Action catalogue: AUDIT_ACTIONS below (documented in docs/SECURITY.md).
 */

export type AuditActorKind = 'user' | 'system' | 'runner';

export interface AuditEntry {
  /** Dotted action name, see AUDIT_ACTIONS (other lots may add their own `domain.verb`). */
  action: string;
  /** French summary shown in « Journal de sécurité ». */
  summary: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  actorUserId?: string | null;
  actorKind?: AuditActorKind;
  /** Overrides the IP/UA read from the current request (e.g. Better Auth hooks, runner callbacks). */
  ip?: string | null;
  userAgent?: string | null;
}

export const AUDIT_ACTIONS = {
  setupOwnerCreated: 'auth.owner_created',
  setupTokenRejected: 'auth.setup_token_rejected',
  signIn: 'auth.sign_in',
  signInNewDevice: 'auth.sign_in_new_device',
  signInFailed: 'auth.sign_in_failed',
  signOut: 'auth.sign_out',
  secondFactorFailed: 'auth.2fa_failed',
  twoFactorEnabled: 'auth.2fa_enabled',
  backupCodeUsed: 'auth.backup_code_used',
  backupCodesRegenerated: 'auth.backup_codes_regenerated',
  passkeyAdded: 'auth.passkey_added',
  passkeyRemoved: 'auth.passkey_removed',
  passwordChanged: 'auth.password_changed',
  sessionRevoked: 'auth.session_revoked',
  otherSessionsRevoked: 'auth.other_sessions_revoked',
  sessionExpired: 'auth.session_expired',
  settingsUpdated: 'settings.updated',
} as const;

const SECRET_KEY_PATTERN = /password|passwd|secret|token|authorization|cookie|private[-_]?key|api[-_]?key|credential|^code$|^codes$/i;
const MAX_METADATA_BYTES = 8_192;

/** Drops secret-looking keys (recursively) and truncates long strings. */
export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeMetadata(item, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) continue;
      result[key] = sanitizeMetadata(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

async function requestContext(): Promise<{ ip: string | null; userAgent: string | null }> {
  try {
    const { headers } = await import('next/headers');
    const h = await headers();
    return { ip: getClientIp(h), userAgent: getUserAgent(h) };
  } catch {
    // Outside a request scope (scripts, background jobs, tests).
    return { ip: null, userAgent: null };
  }
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    const context =
      entry.ip !== undefined || entry.userAgent !== undefined
        ? { ip: entry.ip ?? null, userAgent: entry.userAgent ?? null }
        : await requestContext();
    let metadata = entry.metadata ? (sanitizeMetadata(entry.metadata) as Record<string, unknown>) : null;
    if (metadata && JSON.stringify(metadata).length > MAX_METADATA_BYTES) metadata = { truncated: true };
    await db.insert(auditLog).values({
      action: entry.action.slice(0, 120),
      summary: entry.summary.slice(0, 500),
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata,
      actorUserId: entry.actorUserId ?? null,
      actorKind: entry.actorKind ?? (entry.actorUserId ? 'user' : 'system'),
      ip: context.ip,
      userAgent: context.userAgent,
    });
  } catch (error) {
    console.error('[audit] écriture impossible', entry.action, error instanceof Error ? error.message : error);
  }
}

export interface AuditRecord {
  id: number;
  action: string;
  summary: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  actorKind: AuditActorKind;
  actorUserId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface ListAuditOptions {
  /** Page size (default 50, max 200). */
  limit?: number;
  /** Cursor: only entries with an id lower than this (pass the previous `nextCursor`). */
  before?: number;
  /** Exact action names. */
  actions?: string[];
  /** Action prefixes, e.g. ['auth.'] for the security journal. */
  prefixes?: string[];
  targetType?: string;
  targetId?: string;
}

/** Most recent first. `nextCursor` is null on the last page. */
export async function listAudit(options: ListAuditOptions = {}): Promise<{ items: AuditRecord[]; nextCursor: number | null }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const filters: SQL[] = [];
  if (options.before !== undefined) filters.push(lt(auditLog.id, options.before));
  const actionFilters: SQL[] = [];
  if (options.actions?.length) actionFilters.push(inArray(auditLog.action, options.actions));
  for (const prefix of options.prefixes ?? []) {
    actionFilters.push(like(auditLog.action, `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  }
  if (actionFilters.length) filters.push(actionFilters.length === 1 ? actionFilters[0]! : or(...actionFilters)!);
  if (options.targetType) filters.push(eq(auditLog.targetType, options.targetType));
  if (options.targetId) filters.push(eq(auditLog.targetId, options.targetId));

  const rows = await db
    .select()
    .from(auditLog)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit).map((row) => ({
    id: row.id,
    action: row.action,
    summary: row.summary,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: row.metadata ?? null,
    actorKind: (row.actorKind as AuditActorKind) ?? 'system',
    actorUserId: row.actorUserId,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
  }));
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}

/** Actions shown in « Journal de sécurité » (auth events, settings, and any `security.*`/sensitive action). */
export const SECURITY_JOURNAL_PREFIXES = ['auth.', 'settings.', 'security.', 'permission.', 'integration.'] as const;
