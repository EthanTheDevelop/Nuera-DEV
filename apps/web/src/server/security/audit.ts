import 'server-only';
import { auditLog, user } from '@nuera/db/schema';
import { and, desc, eq, inArray, like, lt, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { getClientIp, getUserAgent } from '@/server/security/request-info';

/**
 * Journal of sensitive actions — table `audit_log` (docs/MULTICOMPTE.md §9).
 *
 *   await audit({ action: 'git.push', summary: 'push de crm-core vers origin · Nuera OS',
 *                 targetType: 'project', targetId: project.id, actorUserId: user.id,
 *                 spaceId: project.spaceId, environmentId: project.environmentId });
 *
 * - `summary` is the short French line shown in the journal, after the date
 *   (« connexion depuis un nouvel appareil (Lyon) », « codes de secours régénérés »).
 * - `spaceId` for a business event (projects, sessions, Git, permissions, integrations, space
 *   settings), `environmentId` for the server it ran on, `subjectUserId` for the account the event
 *   concerns (an administrator's action on it, a sign-in attempt on its e-mail). None has a foreign
 *   key: rows survive deletions.
 * - `actorLabel` is the author's e-mail frozen at write time; filled from `actorUserId` when omitted.
 * - IP and user agent are captured from the current request (next/headers) when available.
 * - Metadata keys that look like secrets are dropped; never pass secret values anyway.
 * - Never throws: a failure is logged on the server and the calling action goes on.
 *
 * Readers: `listUserJournal` (Paramètres, one account) and `listInstanceJournal` (Administration).
 * Action catalogue: AUDIT_ACTIONS below (documented in docs/SECURITY.md).
 */

export type AuditActorKind = 'user' | 'system' | 'runner';

export interface AuditEntry {
  /** Dotted action name, see AUDIT_ACTIONS (other lots may add their own `domain.verb`). */
  action: string;
  /** French summary shown in the journal. */
  summary: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  actorUserId?: string | null;
  actorKind?: AuditActorKind;
  /** Author's e-mail; read from `actorUserId` when omitted (pass null to store none). */
  actorLabel?: string | null;
  /** Space of a business event (null for account and instance events). */
  spaceId?: string | null;
  /** Server the event happened on. */
  environmentId?: string | null;
  /** Account the event concerns (failed sign-in on its e-mail, administrator action on it…). */
  subjectUserId?: string | null;
  /** Overrides the IP/UA read from the current request (e.g. Better Auth hooks, runner callbacks). */
  ip?: string | null;
  userAgent?: string | null;
}

export const AUDIT_ACTIONS = {
  setupOwnerCreated: 'auth.owner_created',
  setupTokenRejected: 'auth.setup_token_rejected',
  /** Activation steps (server/auth/setup.ts SETUP_ACTIONS, tied to `metadata.twoFactorId`). */
  setupCodesAcknowledged: 'auth.setup_codes_acknowledged',
  setupCompleted: 'auth.setup_completed',
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
  /** Space settings, server limits and personal preferences (`metadata.scope`). */
  settingsUpdated: 'settings.updated',
  /** Instance settings (administrators): shown in the instance journal. */
  // Written by auth/password-reset.ts and the 2FA settings (catalogue alignment).
  passwordResetRequested: 'auth.password_reset_requested',
  passwordResetMailFailed: 'auth.password_reset_mail_failed',
  passwordReset: 'auth.password_reset',
  twoFactorDisabled: 'auth.2fa_disabled',
  instanceSettingsUpdated: 'instance.settings_updated',
  // Configuration Claude commune (lot K1, server/claude-config): instance journal.
  claudeRuleCreated: 'instance.claude_rule_created',
  claudeRuleUpdated: 'instance.claude_rule_updated',
  claudeRuleDeleted: 'instance.claude_rule_deleted',
  claudeRulesReordered: 'instance.claude_rules_reordered',
  claudeSkillCreated: 'instance.claude_skill_created',
  claudeSkillUpdated: 'instance.claude_skill_updated',
  claudeSkillDeleted: 'instance.claude_skill_deleted',
  claudeMcpCreated: 'instance.claude_mcp_created',
  claudeMcpUpdated: 'instance.claude_mcp_updated',
  claudeMcpDeleted: 'instance.claude_mcp_deleted',
  claudeMcpTested: 'instance.claude_mcp_tested',
  claudePolicyUpdated: 'instance.claude_policy_updated',
  claudeVersionRestored: 'instance.claude_version_restored',
  claudeProposalCreated: 'instance.claude_proposal_created',
  claudeProposalApproved: 'instance.claude_proposal_approved',
  claudeProposalRejected: 'instance.claude_proposal_rejected',
  /** Name or location of a server changed by an administrator. */
  environmentUpdated: 'environment.updated',
  /** Recovery link printed by `pnpm --filter @nuera/db cli recovery-link` (packages/db/src/recovery.ts). */
  recoveryLinkCli: 'admin.recovery_link_cli',
  /** Recovery link created by an administrator. */
  recoveryLinkCreated: 'admin.recovery_link_created',
  /** Administration › Comptes (`subject_user_id` = the account concerned). */
  invitationCreated: 'admin.invitation_created',
  invitationRevoked: 'admin.invitation_revoked',
  roleChanged: 'admin.role_changed',
  accountDisabled: 'admin.account_disabled',
  accountEnabled: 'admin.account_enabled',
  accountDeleted: 'admin.account_deleted',
  /** Administration › Serveurs (`environment_id` = the server). */
  serverRegistered: 'admin.server_registered',
  serverVerified: 'admin.server_verified',
  serverAssigned: 'admin.server_assigned',
  serverTokenRotated: 'admin.server_token_rotated',
  serverUpdated: 'admin.server_updated',
  serverRetired: 'admin.server_retired',
  serverDatabaseRestricted: 'admin.server_database_restricted',
  /** Account created by accepting an invitation, recovery link used (activation steps). */
  invitationAccepted: 'auth.invitation_accepted',
  recoveryLinkUsed: 'auth.recovery_link_used',
  passkeyRenamed: 'auth.passkey_renamed',
  /** A rotated server token answered and replaced the previous one (system). */
  environmentTokenPromoted: 'environment.token_promoted',
  /** Web Push subscriptions of this device (« Notifications sur ce téléphone »). */
  pushSubscribed: 'security.push_subscribed',
  pushUnsubscribed: 'security.push_unsubscribed',
  pushRenewed: 'security.push_renewed',
  /** A runner asked for a resource of another server (internal routes). */
  runnerScopeViolation: 'security.runner_scope_violation',
} as const;

/** Personal journal: my own account events… */
export const USER_JOURNAL_OWN_PREFIXES = ['auth.', 'settings.', 'security.'] as const;
/** …the events that concern my account (written by someone else: administrator, failed sign-in)… */
export const USER_JOURNAL_SUBJECT_PREFIXES = ['auth.', 'admin.', 'security.', 'settings.'] as const;
/** …and the permission, integration and settings events of my spaces. */
export const USER_JOURNAL_SPACE_PREFIXES = ['permission.', 'integration.', 'settings.'] as const;
/** Instance journal (administrators): never git.*, project.*, session.*, terminal.*. */
export const INSTANCE_JOURNAL_PREFIXES = ['auth.', 'admin.', 'environment.', 'instance.', 'security.'] as const;

const SECRET_KEY_PATTERN = /password|passwd|secret|token|authorization|cookie|private[-_]?key|api[-_]?key|credential|^code$|^codes$/i;
const MAX_METADATA_BYTES = 8_192;
const uuidSchema = z.uuid();

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

async function actorEmail(actorUserId: string): Promise<string | null> {
  const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, actorUserId)).limit(1);
  return row?.email ?? null;
}

/** A uuid column value, or null (a malformed id must not make the journal write fail). */
function uuidOrNull(value: string | null | undefined): string | null {
  return value && uuidSchema.safeParse(value).success ? value : null;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    const context =
      entry.ip !== undefined || entry.userAgent !== undefined
        ? { ip: entry.ip ?? null, userAgent: entry.userAgent ?? null }
        : await requestContext();
    let metadata = entry.metadata ? (sanitizeMetadata(entry.metadata) as Record<string, unknown>) : null;
    if (metadata && JSON.stringify(metadata).length > MAX_METADATA_BYTES) metadata = { truncated: true };
    const actorUserId = entry.actorUserId ?? null;
    const actorLabel =
      entry.actorLabel !== undefined ? entry.actorLabel : actorUserId ? await actorEmail(actorUserId).catch(() => null) : null;
    await db.insert(auditLog).values({
      action: entry.action.slice(0, 120),
      summary: entry.summary.slice(0, 500),
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata,
      actorUserId,
      actorKind: entry.actorKind ?? (actorUserId ? 'user' : 'system'),
      actorLabel: actorLabel?.slice(0, 320) ?? null,
      spaceId: uuidOrNull(entry.spaceId),
      environmentId: uuidOrNull(entry.environmentId),
      subjectUserId: entry.subjectUserId ?? null,
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
  /** Author's e-mail when the event was written. */
  actorLabel: string | null;
  spaceId: string | null;
  environmentId: string | null;
  subjectUserId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface AuditPage {
  items: AuditRecord[];
  /** Pass as `before` for the next page; null on the last page. */
  nextCursor: number | null;
}

interface PageOptions {
  /** Page size (default 50, max 200). */
  limit?: number;
  /** Cursor: only entries with an id lower than this (pass the previous `nextCursor`). */
  before?: number;
}

function escapeLike(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function actionStartsWith(prefixes: readonly string[]): SQL {
  const filters = prefixes.map((prefix) => like(auditLog.action, `${escapeLike(prefix)}%`));
  return filters.length === 1 ? filters[0]! : or(...filters)!;
}

/** Most recent first. */
async function readPage(scope: SQL, options: PageOptions): Promise<AuditPage> {
  const requested = typeof options.limit === 'number' && Number.isFinite(options.limit) ? Math.trunc(options.limit) : 50;
  const limit = Math.min(Math.max(requested, 1), 200);
  const filters: SQL[] = [scope];
  if (typeof options.before === 'number' && Number.isFinite(options.before)) filters.push(lt(auditLog.id, Math.trunc(options.before)));
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(...filters))
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit).map(
    (row): AuditRecord => ({
      id: row.id,
      action: row.action,
      summary: row.summary,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: row.metadata ?? null,
      actorKind: (row.actorKind as AuditActorKind) ?? 'system',
      actorUserId: row.actorUserId,
      actorLabel: row.actorLabel,
      spaceId: row.spaceId,
      environmentId: row.environmentId,
      subjectUserId: row.subjectUserId,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
    }),
  );
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}

export interface UserJournalOptions extends PageOptions {
  userId: string;
  /** Spaces of the account (v1: its personal space). Ids that are not uuids are ignored. */
  spaceIds: readonly string[];
}

/**
 * Personal journal (Paramètres › Compte et sécurité): my `auth.*` / `settings.*` / `security.*`
 * events, the events that concern my account (administrator actions, failed sign-ins on my e-mail),
 * and the `permission.*` / `integration.*` / `settings.*` events of my spaces. Nothing else: never
 * another account's events, never another space's.
 */
export async function listUserJournal(options: UserJournalOptions): Promise<AuditPage> {
  if (!options.userId) return { items: [], nextCursor: null };
  const spaceIds = [...new Set(options.spaceIds)].filter((id) => uuidSchema.safeParse(id).success);
  const branches: SQL[] = [
    and(eq(auditLog.actorUserId, options.userId), actionStartsWith(USER_JOURNAL_OWN_PREFIXES))!,
    and(eq(auditLog.subjectUserId, options.userId), actionStartsWith(USER_JOURNAL_SUBJECT_PREFIXES))!,
  ];
  if (spaceIds.length) branches.push(and(inArray(auditLog.spaceId, spaceIds), actionStartsWith(USER_JOURNAL_SPACE_PREFIXES))!);
  return readPage(or(...branches)!, options);
}

export interface InstanceJournalOptions extends PageOptions {
  /** Only the events written by, or concerning, this account. */
  userId?: string;
}

/**
 * Instance journal (Administration › Journal, owner and administrators only — the caller checks the
 * role): `auth.*`, `admin.*`, `environment.*`, `instance.*`, `security.*` of every account. Never a
 * business event (`git.*`, `project.*`, `session.*`, `terminal.*`, `permission.*`, `integration.*`).
 */
export async function listInstanceJournal(options: InstanceJournalOptions = {}): Promise<AuditPage> {
  const filters: SQL[] = [actionStartsWith(INSTANCE_JOURNAL_PREFIXES)];
  if (options.userId) filters.push(or(eq(auditLog.actorUserId, options.userId), eq(auditLog.subjectUserId, options.userId))!);
  return readPage(and(...filters)!, options);
}
