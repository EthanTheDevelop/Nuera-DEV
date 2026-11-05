import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { getNotificationCounts, markAllNotificationsRead, markNotificationsRead } from '@/server/notifications';

/**
 * POST /api/notifications/read — `{ ids: [uuid, …] }` marks these notifications as read,
 * `{ all: true }` marks every unread notification. Returns the number changed and the new counts.
 */

export const dynamic = 'force-dynamic';

const bodySchema = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(200) }),
  z.object({ all: z.literal(true) }),
]);

export const POST = apiRoute({
  body: bodySchema,
  handler: async ({ body }) => {
    const updated = 'all' in body ? await markAllNotificationsRead() : await markNotificationsRead(body.ids);
    return { updated, counts: await getNotificationCounts() };
  },
});
