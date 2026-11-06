import 'server-only';
import { environments, notifications, projects, sessions, spaceMembers, user } from '@nuera/db/schema';
import type { NotificationKind, Severity } from '@nuera/db/schema';
import { and, count, desc, eq, getTableColumns, inArray, isNull, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { sendPush, type SendPushResult } from '@/server/push';
import { publishUserEvent } from './user-events';

/**
 * Notification centre (bell, D01 tiles) + Web Push — one row per recipient (docs/MULTICOMPTE.md §9).
 *
 *   const { spaceId, userIds } = (await environmentRecipients(environmentId))!;
 *   await createNotification(
 *     { kind: 'permission_request', severity: 'warning', title: 'Tests e2e du devis attend votre accord',
 *       body: 'npm run test -- e2e · Nuera OS · touchez pour répondre', href: `/workspace/${id}#demande-${requestId}`,
 *       sessionId: id, dedupKey: `permission:${requestId}` },
 *     { spaceId, userIds },
 *   );
 *
 * Dedup: at most ONE unread notification per recipient and `dedupKey` (unique index
 * notifications_user_dedup_unread_idx); a new event with the same key refreshes that notification
 * (no second push), space and references included. The index ignores the space: a key must name
 * what it is about when the same event can come from several spaces or servers a recipient sees.
 * An event that comes from a server (`target.environmentId`, the runner's /api/internal/notify) is
 * therefore stored under `server:<environmentId>:<key>` ({@link serverDedupKey}): `claude:auth` of
 * an unassigned server (administrators) and of an administrator's own server stay two
 * notifications, while the alerts of one server keep merging when it is assigned to a space.
 * Every reader takes the recipient: an account never sees, counts, reads or opens
 * another account's notifications. A notification about a space only goes to members of that
 * space; its project/session references are kept only when they belong to that space.
 *
 * Dedup keys: `permission:<requestId>`, `session:<id>:…`, `claude:auth`, `integration:coolify:<state>`,
 * `integration:mcp:<name>:<state>`, and for GitHub (MULTICOMPTE.md §14.1) `githubDedupKey(…)`.
 *
 * Every creation, refresh and read is published on the account's event channel (`user-events.ts`).
 */

export const NOTIFICATION_KINDS = [
  'permission_request',
  'session_attention',
  'session_finished',
  'session_failed',
  'session_interrupted',
  'operation_failed',
  'operation_succeeded',
  'integration_expiring',
  'integration_expired',
  'integration_error',
  'claude_disconnected',
  'server',
  'security',
] as const satisfies readonly NotificationKind[];

export const SEVERITIES = ['info', 'success', 'warning', 'danger'] as const satisfies readonly Severity[];

/** Kinds sent to the phone by default (successes stay in the bell only). */
const PUSHED_KINDS = new Set<NotificationKind>(NOTIFICATION_KINDS.filter((kind) => kind !== 'operation_succeeded'));

export type IntegrationAlertState = 'expiring' | 'expired' | 'error';

/**
 * GitHub alert keys (MULTICOMPTE.md §14.1): `integration:github:<sourceId>:<state>` for a source,
 * `integration:github:fallback:<state>` for GITHUB_FALLBACK_TOKEN (no source).
 */
export function githubDedupKey(source: string | 'fallback', state: IntegrationAlertState): string {
  return `${githubDedupPrefix(source)}${state}`;
}

/**
 * Dedup key of an event that comes from a server: `server:<environmentId>:<key>` (idempotent).
 * The same key sent by two servers (`claude:auth`) never merges into one notification.
 */
export function serverDedupKey(environmentId: string, key: string): string {
  const prefix = `server:${environmentId}:`;
  return key.startsWith(prefix) ? key : `${prefix}${key}`;
}

/** Prefix that resolves every alert of one GitHub source (or of the fallback token). */
export function githubDedupPrefix(source: string | 'fallback'): string {
  if (!source || source.includes(':')) throw new Error('Source GitHub invalide pour une clé de notification.');
  return `integration:github:${source}:`;
}

const relativeHref = z
  .string()
  .trim()
  .max(500)
  .refine((value) => value.startsWith('/') && !value.startsWith('//') && !value.includes('\\'), 'chemin relatif attendu (« /sessions/… »)');

export const notificationInputSchema = z.object({
  kind: z.enum(NOTIFICATION_KINDS),
  severity: z.enum(SEVERITIES).default('info'),
  title: z.string().trim().min(1, 'titre requis').max(200),
  body: z.string().trim().max(1000).nullish(),
  href: relativeHref.nullish(),
  sessionId: z.uuid().nullish(),
  projectId: z.uuid().nullish(),
  dedupKey: z.string().trim().min(1).max(200).nullish(),
});
export type NotificationInput = z.input<typeof notificationInputSchema>;

/** Who receives a notification. */
export const notificationTargetSchema = z.object({
  /** Space the notification is about; null/absent for an instance alert. Recipients must be its members. */
  spaceId: z.uuid().nullish(),
  /** Recipients (duplicates ignored; deleted accounts and, for a space, non-members are skipped). */
  userIds: z.array(z.string().min(1).max(200)).max(200),
  /** Server the event comes from: carried in the live event and scopes the dedup key ({@link serverDedupKey}). */
  environmentId: z.uuid().nullish(),
});
export type NotificationTarget = z.input<typeof notificationTargetSchema>;

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  severity: Severity;
  title: string;
  body: string | null;
  href: string | null;
  spaceId: string | null;
  projectId: string | null;
  sessionId: string | null;
  dedupKey: string | null;
  read: boolean;
  readAt: string | null;
  pushedAt: string | null;
  createdAt: string;
}

type NotificationRow = typeof notifications.$inferSelect;

function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    href: row.href,
    spaceId: row.spaceId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    dedupKey: row.dedupKey,
    read: row.readAt !== null,
    readAt: row.readAt?.toISOString() ?? null,
    pushedAt: row.pushedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface RecipientNotification {
  userId: string;
  notification: NotificationView;
  /** false when an unread notification of this recipient with the same dedupKey was refreshed instead. */
  created: boolean;
  /** Push to this recipient's devices (null: not attempted). */
  push: SendPushResult | null;
}

export interface CreateNotificationResult {
  /** One entry per recipient actually notified. */
  recipients: RecipientNotification[];
  /** Number of new notifications (the others were refreshed). */
  created: number;
}

export interface CreateNotificationOptions {
  /** Send a Web Push for a NEW notification (default: true for every kind but operation_succeeded). */
  push?: boolean;
  /** Injected in tests. */
  sendPushImpl?: typeof sendPush;
}

/** Recipients that exist, are not deleted and, for a space, belong to it. */
async function eligibleRecipients(userIds: readonly string[], spaceId: string | null): Promise<string[]> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return [];
  const rows = spaceId
    ? await db
        .select({ id: user.id })
        .from(user)
        .innerJoin(spaceMembers, and(eq(spaceMembers.userId, user.id), eq(spaceMembers.spaceId, spaceId)))
        .where(and(inArray(user.id, unique), isNull(user.deletedAt)))
    : await db
        .select({ id: user.id })
        .from(user)
        .where(and(inArray(user.id, unique), isNull(user.deletedAt)));
  const allowed = new Set(rows.map((row) => row.id));
  return unique.filter((id) => allowed.has(id));
}

/** Keeps a project reference only when the project exists in this space. */
async function projectInSpace(id: string, spaceId: string | null): Promise<string | null> {
  if (!spaceId) return null;
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.spaceId, spaceId)))
    .limit(1);
  return row?.id ?? null;
}

/** Keeps a session reference only when the session exists in this space (a session may be gone). */
async function sessionInSpace(id: string, spaceId: string | null): Promise<string | null> {
  if (!spaceId) return null;
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(and(eq(sessions.id, id), eq(projects.spaceId, spaceId)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Creates (or refreshes, when `dedupKey` matches an unread one of the same recipient) one
 * notification per recipient, publishes it on each recipient's channel, then pushes the new ones
 * to their own devices only.
 */
export async function createNotification(
  input: NotificationInput,
  target: NotificationTarget,
  options: CreateNotificationOptions = {},
): Promise<CreateNotificationResult> {
  const data = notificationInputSchema.parse(input);
  const scope = notificationTargetSchema.parse(target);
  const spaceId = scope.spaceId ?? null;
  const recipients = await eligibleRecipients(scope.userIds, spaceId);
  if (recipients.length === 0) return { recipients: [], created: 0 };

  const values = {
    spaceId,
    kind: data.kind,
    severity: data.severity,
    title: data.title,
    body: data.body ?? null,
    href: data.href ?? null,
    sessionId: data.sessionId ? await sessionInSpace(data.sessionId, spaceId) : null,
    projectId: data.projectId ? await projectInSpace(data.projectId, spaceId) : null,
    dedupKey: data.dedupKey ? (scope.environmentId ? serverDedupKey(scope.environmentId, data.dedupKey) : data.dedupKey) : null,
  };

  // One statement for every recipient; concurrent writers of the same key are serialised by the
  // unique partial index. (xmax = 0) is true for an inserted row, false for an updated one.
  const rows = await db
    .insert(notifications)
    .values(recipients.map((userId) => ({ ...values, userId })))
    .onConflictDoUpdate({
      target: [notifications.userId, notifications.dedupKey],
      targetWhere: sql.raw('read_at is null and dedup_key is not null'),
      // The refreshed row describes the latest event entirely (its space and references included).
      set: {
        spaceId: values.spaceId,
        kind: values.kind,
        severity: values.severity,
        title: values.title,
        body: values.body,
        href: values.href,
        projectId: values.projectId,
        sessionId: values.sessionId,
      },
    })
    .returning({ ...getTableColumns(notifications), created: sql<boolean>`(xmax = 0)` });

  const shouldPush = options.push ?? PUSHED_KINDS.has(values.kind);
  const pushImpl = options.sendPushImpl ?? sendPush;
  const results = await Promise.all(
    rows.map(async ({ created, ...row }): Promise<RecipientNotification> => {
      let current: NotificationRow = row;
      let push: SendPushResult | null = null;
      if (created && shouldPush) {
        try {
          push = await pushImpl(
            {
              title: row.title,
              body: row.body,
              url: row.href ?? '/',
              tag: row.dedupKey ?? row.id,
              severity: row.severity,
              kind: row.kind,
              notificationId: row.id,
            },
            { userIds: [row.userId] },
          );
          if (push.sent > 0) {
            const [pushed] = await db
              .update(notifications)
              .set({ pushedAt: new Date() })
              .where(and(eq(notifications.id, row.id), eq(notifications.userId, row.userId)))
              .returning();
            if (pushed) current = pushed;
          }
        } catch (error) {
          console.error('[notifications] envoi push impossible', error instanceof Error ? error.message : error);
        }
      }
      publishUserEvent(current.userId, {
        type: 'notification.created',
        at: current.createdAt.toISOString(),
        data: {
          id: current.id,
          kind: current.kind,
          severity: current.severity,
          title: current.title,
          body: current.body,
          href: current.href,
          projectId: current.projectId,
          sessionId: current.sessionId,
          environmentId: scope.environmentId ?? null,
        },
      });
      return { userId: current.userId, notification: toView(current), created: Boolean(created), push };
    }),
  );
  return { recipients: results, created: results.filter((result) => result.created).length };
}

// ---------------------------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------------------------

/** Members of a space whose account is not deleted. */
export async function spaceRecipients(spaceId: string): Promise<string[]> {
  if (!z.uuid().safeParse(spaceId).success) return [];
  const rows = await db
    .select({ id: user.id })
    .from(spaceMembers)
    .innerJoin(user, eq(user.id, spaceMembers.userId))
    .where(and(eq(spaceMembers.spaceId, spaceId), isNull(user.deletedAt)));
  return rows.map((row) => row.id);
}

/** Owner and administrators that are neither disabled nor deleted (instance alerts). */
export async function instanceAdminRecipients(): Promise<string[]> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(and(inArray(user.role, ['owner', 'admin']), isNull(user.disabledAt), isNull(user.deletedAt)));
  return rows.map((row) => row.id);
}

/**
 * Recipients of an event of a server: the members of its space, or the administrators when it is
 * not assigned (spaceId null). null for an unknown server.
 */
export async function environmentRecipients(environmentId: string): Promise<{ spaceId: string | null; userIds: string[] } | null> {
  if (!z.uuid().safeParse(environmentId).success) return null;
  const [row] = await db
    .select({ spaceId: environments.spaceId })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!row) return null;
  return row.spaceId
    ? { spaceId: row.spaceId, userIds: await spaceRecipients(row.spaceId) }
    : { spaceId: null, userIds: await instanceAdminRecipients() };
}

// ---------------------------------------------------------------------------------------------
// Readers (always one recipient)
// ---------------------------------------------------------------------------------------------

export interface ListNotificationsOptions {
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
}

export interface NotificationCounts {
  unread: number;
  total: number;
  unreadBySeverity: Record<Severity, number>;
}

/** An integer option, or the fallback for anything else (NaN, Infinity, a string from a query). */
function finiteInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

const EMPTY_COUNTS = (): NotificationCounts => ({ unread: 0, total: 0, unreadBySeverity: { info: 0, success: 0, warning: 0, danger: 0 } });

/** This account's notifications: unread first, then most recent first. */
export async function listNotifications(
  userId: string,
  options: ListNotificationsOptions = {},
): Promise<{ items: NotificationView[]; counts: NotificationCounts; nextOffset: number | null }> {
  if (!userId) return { items: [], counts: EMPTY_COUNTS(), nextOffset: null };
  const limit = Math.min(Math.max(finiteInt(options.limit, 30), 1), 100);
  const offset = Math.max(finiteInt(options.offset, 0), 0);
  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), options.unreadOnly ? isNull(notifications.readAt) : undefined))
    .orderBy(sql`(${notifications.readAt} is null) desc`, desc(notifications.createdAt), desc(notifications.id))
    .limit(limit + 1)
    .offset(offset);
  const counts = await getNotificationCounts(userId);
  return {
    items: rows.slice(0, limit).map(toView),
    counts,
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}

export async function getNotificationCounts(userId: string): Promise<NotificationCounts> {
  const result = EMPTY_COUNTS();
  if (!userId) return result;
  const rows = await db
    .select({ severity: notifications.severity, unread: sql<boolean>`${notifications.readAt} is null`, n: count() })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .groupBy(notifications.severity, sql`${notifications.readAt} is null`);
  for (const row of rows) {
    result.total += row.n;
    if (row.unread) {
      result.unread += row.n;
      result.unreadBySeverity[row.severity] = (result.unreadBySeverity[row.severity] ?? 0) + row.n;
    }
  }
  return result;
}

/** Marks some of this account's notifications read (another account's ids are ignored). */
export async function markNotificationsRead(userId: string, ids: readonly string[]): Promise<number> {
  const unique = [...new Set(ids)].filter((id) => z.uuid().safeParse(id).success);
  if (!userId || unique.length === 0) return 0;
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), inArray(notifications.id, unique), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  if (rows.length) publishUserEvent(userId, { type: 'notification.read', at: new Date().toISOString(), data: { all: false, ids: rows.map((row) => row.id) } });
  return rows.length;
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  if (!userId) return 0;
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  if (rows.length) publishUserEvent(userId, { type: 'notification.read', at: new Date().toISOString(), data: { all: true } });
  return rows.length;
}

export interface ResolveScope {
  /** Space whose notifications are resolved; null for instance alerts. */
  spaceId: string | null;
  /** Restrict to these recipients (default: every recipient of the space). */
  userIds?: readonly string[];
}

/**
 * Marks as read the unread notifications of this space (or instance alerts) whose dedupKey starts
 * with `prefix` (problem solved). Never touches another space's notifications.
 */
export async function resolveNotifications(scope: ResolveScope, prefix: string): Promise<number> {
  if (!prefix) return 0;
  if (scope.spaceId !== null && !z.uuid().safeParse(scope.spaceId).success) return 0;
  if (scope.userIds && scope.userIds.length === 0) return 0;
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        scope.spaceId === null ? isNull(notifications.spaceId) : eq(notifications.spaceId, scope.spaceId),
        scope.userIds ? inArray(notifications.userId, [...scope.userIds]) : undefined,
        like(notifications.dedupKey, `${escaped}%`),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id, userId: notifications.userId });
  const byUser = new Map<string, string[]>();
  for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.id]);
  const at = new Date().toISOString();
  for (const [userId, ids] of byUser) publishUserEvent(userId, { type: 'notification.read', at, data: { all: false, ids } });
  return rows.length;
}

/** One of this account's notifications; null for an unknown id or another account's. */
export async function getNotification(userId: string, id: string): Promise<NotificationView | null> {
  if (!userId || !z.uuid().safeParse(id).success) return null;
  const [row] = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
    .limit(1);
  return row ? toView(row) : null;
}
