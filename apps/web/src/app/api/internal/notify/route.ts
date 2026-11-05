import { internalRoute } from '@/server/http';
import { notificationInputSchema, notify } from '@/server/notifications';

/**
 * POST /api/internal/notify — runner → web (Bearer RUNNER_TOKEN).
 * Creates a notification (one unread notification per `dedupKey`) and sends it by Web Push.
 *
 *   { kind, severity, title, body?, href?, sessionId?, projectId?, dedupKey? }
 *   → { notification, created, push: { sent, pruned, failed, skipped } | null }
 */

export const dynamic = 'force-dynamic';

export const POST = internalRoute({
  body: notificationInputSchema,
  handler: async ({ body }) => notify(body),
});
