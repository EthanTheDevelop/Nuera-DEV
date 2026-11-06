import { internalRoute } from '@/server/http';
import { createNotification, notificationInputSchema } from '@/server/notifications';
import { assertCallerReferences, recipientsOfCaller } from '@/server/tenancy/runner-scope';

/**
 * POST /api/internal/notify — runner → web (Bearer token of its server).
 * Creates a notification for each member of the space of the CALLER'S server (the administrators
 * while the server is not assigned), one unread notification per `dedupKey` and recipient, sent by
 * Web Push. A `sessionId` / `projectId` of another server answers 404 and is journalled
 * (`security.runner_scope_violation`); an unknown one only loses its link.
 *
 *   { kind, severity, title, body?, href?, sessionId?, projectId?, dedupKey? }
 *   → { created, recipients, notification? } — `created`: at least one new notification;
 *     `notification`: the first recipient's (its `id` feeds the runner's `notification.created`).
 */

export const dynamic = 'force-dynamic';

export const POST = internalRoute({
  body: notificationInputSchema,
  handler: async ({ body, environment }) => {
    await assertCallerReferences(environment, { sessionId: body.sessionId, projectId: body.projectId }, 'notify');
    const userIds = await recipientsOfCaller(environment);
    const result = await createNotification(body, { spaceId: environment.spaceId, userIds, environmentId: environment.id });
    const first = result.recipients[0];
    return {
      created: result.created > 0,
      recipients: result.recipients.length,
      ...(first ? { notification: first.notification } : {}),
    };
  },
});
