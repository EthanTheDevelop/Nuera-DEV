import { sessions } from '@nuera/db/schema';
import { parseUsageLimit } from '@nuera/shared/runner';
import { formatClockDay } from '@nuera/shared/format';
import { and, eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { internalRoute } from '@/server/http';
import { createNotification, notificationInputSchema, type NotificationInput } from '@/server/notifications';
import { audit } from '@/server/security/audit';
import type { CallerEnvironment } from '@/server/security/runner-token';
import { assertCallerReferences, recipientsOfCaller } from '@/server/tenancy/runner-scope';

/**
 * POST /api/internal/notify — runner → web (Bearer token of its server).
 * Creates a notification for each member of the space of the CALLER'S server (the administrators
 * while the server is not assigned), one unread notification per `dedupKey` and recipient, sent by
 * Web Push. A `sessionId` / `projectId` of another server answers 404 and is journalled
 * (`security.runner_scope_violation`); an unknown one only loses its link.
 *
 * The usage limit of a session is journalled in its space once per stop (the dedup key): an
 * automatic resumption scheduled (`session.auto_resume_scheduled`, from `sessions.usage_limit`) and
 * one typed (`session.auto_resume_fired`).
 *
 *   { kind, severity, title, body?, href?, sessionId?, projectId?, dedupKey? }
 *   → { created, recipients, notification? } — `created`: at least one new notification;
 *     `notification`: the first recipient's (its `id` feeds the runner's `notification.created`).
 */

export const dynamic = 'force-dynamic';

const AUTO_RESUME_AUDIT_ACTIONS = {
  scheduled: 'session.auto_resume_scheduled',
  fired: 'session.auto_resume_fired',
} as const;

async function auditAutoResume(body: NotificationInput, environment: CallerEnvironment): Promise<void> {
  if (!body.sessionId || (body.kind !== 'session_usage_limit' && body.kind !== 'session_auto_resumed')) return;
  const [row] = await db
    .select({ title: sessions.title, usageLimit: sessions.usageLimit })
    .from(sessions)
    .where(and(eq(sessions.id, body.sessionId), eq(sessions.environmentId, environment.id)))
    .limit(1);
  if (!row) return;
  const limit = parseUsageLimit(row.usageLimit);
  const resume = limit?.autoResume ?? null;
  const base = { targetType: 'session', targetId: body.sessionId, actorKind: 'runner' as const, actorLabel: null, spaceId: environment.spaceId, environmentId: environment.id };
  if (body.kind === 'session_usage_limit') {
    if (!limit?.active || resume?.outcome !== 'scheduled' || !resume.nextAttemptAt) return;
    await audit({
      ...base,
      action: AUTO_RESUME_AUDIT_ACTIONS.scheduled,
      summary: `reprise automatique prévue à ${formatClockDay(resume.nextAttemptAt)} après la limite d'utilisation : « ${row.title} »`,
      metadata: { resetsAt: limit.resetsAt, nextAttemptAt: resume.nextAttemptAt, mode: resume.mode, maxAttempts: resume.maxAttempts, source: limit.source },
    });
    return;
  }
  await audit({
    ...base,
    action: AUTO_RESUME_AUDIT_ACTIONS.fired,
    summary: `session reprise automatiquement après la limite d'utilisation : « ${row.title} »`,
    metadata: { attempt: resume?.attempts ?? null, maxAttempts: resume?.maxAttempts ?? null, resetsAt: limit?.resetsAt ?? null },
  });
}

export const POST = internalRoute({
  body: notificationInputSchema,
  handler: async ({ body, environment }) => {
    await assertCallerReferences(environment, { sessionId: body.sessionId, projectId: body.projectId }, 'notify');
    const userIds = await recipientsOfCaller(environment);
    const result = await createNotification(body, { spaceId: environment.spaceId, userIds, environmentId: environment.id });
    if (result.created > 0) {
      await auditAutoResume(body, environment).catch((error: unknown) => console.error('[notify] journal de la reprise automatique', error instanceof Error ? error.message : error));
    }
    const first = result.recipients[0];
    return {
      created: result.created > 0,
      recipients: result.recipients.length,
      ...(first ? { notification: first.notification } : {}),
    };
  },
});
