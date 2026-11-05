import 'server-only';
import { notifications, projects, sessions } from '@nuera/db/schema';
import type { NotificationKind, Severity } from '@nuera/db/schema';
import { and, count, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { sendPush, type SendPushResult } from '@/server/push';

/**
 * Notification centre (bell, D01 tiles) + Web Push.
 *
 *   await notify({ kind: 'permission_request', severity: 'warning', title: 'Tests e2e du devis attend votre accord',
 *                  body: 'npm run test -- e2e · Nuera OS · touchez pour répondre',
 *                  href: `/sessions/${id}?vue=session`, sessionId: id, dedupKey: `permission:${requestId}` });
 *
 * Dedup: at most ONE unread notification per `dedupKey`; a new event with the same key updates
 * that notification (no second push). Single owner: notifications are global.
 */

export const NOTIFICATION_KINDS = [
  'permission_request',
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

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  severity: Severity;
  title: string;
  body: string | null;
  href: string | null;
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
    projectId: row.projectId,
    sessionId: row.sessionId,
    dedupKey: row.dedupKey,
    read: row.readAt !== null,
    readAt: row.readAt?.toISOString() ?? null,
    pushedAt: row.pushedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CreateNotificationResult {
  notification: NotificationView;
  /** false when an unread notification with the same dedupKey was updated instead. */
  created: boolean;
  push: SendPushResult | null;
}

export interface CreateNotificationOptions {
  /** Send a Web Push for a NEW notification (default: true for every kind but operation_succeeded). */
  push?: boolean;
  /** Injected in tests. */
  sendPushImpl?: typeof sendPush;
}

/** Keeps a reference only when the row exists (a session may be gone when the runner reports it). */
async function existingSessionId(id: string): Promise<string | null> {
  const [row] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).limit(1);
  return row?.id ?? null;
}

async function existingProjectId(id: string): Promise<string | null> {
  const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).limit(1);
  return row?.id ?? null;
}

/** Creates (or refreshes, when `dedupKey` matches an unread one) a notification, then pushes it. */
export async function createNotification(
  input: NotificationInput,
  options: CreateNotificationOptions = {},
): Promise<CreateNotificationResult> {
  const data = notificationInputSchema.parse(input);
  const values = {
    kind: data.kind,
    severity: data.severity,
    title: data.title,
    body: data.body ?? null,
    href: data.href ?? null,
    sessionId: data.sessionId ? await existingSessionId(data.sessionId) : null,
    projectId: data.projectId ? await existingProjectId(data.projectId) : null,
    dedupKey: data.dedupKey ?? null,
  };

  const { row, created } = await db.transaction(async (tx) => {
    if (values.dedupKey) {
      // Serialise writers of the same key (no unique partial index on dedup_key).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notification:${values.dedupKey}`}))`);
      const [existing] = await tx
        .select()
        .from(notifications)
        .where(and(eq(notifications.dedupKey, values.dedupKey), isNull(notifications.readAt)))
        .orderBy(desc(notifications.createdAt))
        .limit(1);
      if (existing) {
        const [updated] = await tx
          .update(notifications)
          .set({ kind: values.kind, severity: values.severity, title: values.title, body: values.body, href: values.href })
          .where(eq(notifications.id, existing.id))
          .returning();
        return { row: updated ?? existing, created: false };
      }
    }
    const [inserted] = await tx.insert(notifications).values(values).returning();
    return { row: inserted!, created: true };
  });

  let push: SendPushResult | null = null;
  const shouldPush = options.push ?? PUSHED_KINDS.has(values.kind);
  if (created && shouldPush) {
    try {
      push = await (options.sendPushImpl ?? sendPush)({
        title: row.title,
        body: row.body,
        url: row.href ?? '/',
        tag: row.dedupKey ?? row.id,
        severity: row.severity,
        kind: row.kind,
        notificationId: row.id,
      });
      if (push.sent > 0) {
        const [pushed] = await db
          .update(notifications)
          .set({ pushedAt: new Date() })
          .where(eq(notifications.id, row.id))
          .returning();
        if (pushed) return { notification: toView(pushed), created, push };
      }
    } catch (error) {
      console.error('[notifications] envoi push impossible', error instanceof Error ? error.message : error);
    }
  }
  return { notification: toView(row), created, push };
}

/** Alias used by services and the runner callback (`POST /api/internal/notify`). */
export const notify = createNotification;

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

/** Unread first, then most recent first. */
export async function listNotifications(options: ListNotificationsOptions = {}): Promise<{
  items: NotificationView[];
  counts: NotificationCounts;
  nextOffset: number | null;
}> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const rows = await db
    .select()
    .from(notifications)
    .where(options.unreadOnly ? isNull(notifications.readAt) : undefined)
    .orderBy(sql`(${notifications.readAt} is null) desc`, desc(notifications.createdAt), desc(notifications.id))
    .limit(limit + 1)
    .offset(offset);
  const counts = await getNotificationCounts();
  return {
    items: rows.slice(0, limit).map(toView),
    counts,
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}

export async function getNotificationCounts(): Promise<NotificationCounts> {
  const rows = await db
    .select({ severity: notifications.severity, unread: sql<boolean>`${notifications.readAt} is null`, n: count() })
    .from(notifications)
    .groupBy(notifications.severity, sql`${notifications.readAt} is null`);
  const unreadBySeverity: Record<Severity, number> = { info: 0, success: 0, warning: 0, danger: 0 };
  let unread = 0;
  let total = 0;
  for (const row of rows) {
    total += row.n;
    if (row.unread) {
      unread += row.n;
      unreadBySeverity[row.severity] = (unreadBySeverity[row.severity] ?? 0) + row.n;
    }
  }
  return { unread, total, unreadBySeverity };
}

export async function markNotificationsRead(ids: string[]): Promise<number> {
  const unique = [...new Set(ids)].filter((id) => z.uuid().safeParse(id).success);
  if (unique.length === 0) return 0;
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(inArray(notifications.id, unique), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}

export async function markAllNotificationsRead(): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(isNull(notifications.readAt))
    .returning({ id: notifications.id });
  return rows.length;
}

/** Marks as read the unread notifications whose dedupKey starts with `prefix` (problem solved). */
export async function resolveNotifications(prefix: string): Promise<number> {
  if (!prefix) return 0;
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(like(notifications.dedupKey, `${escaped}%`), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}

export async function getNotification(id: string): Promise<NotificationView | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
  return row ? toView(row) : null;
}
