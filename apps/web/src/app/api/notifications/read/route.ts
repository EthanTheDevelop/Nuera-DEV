import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { getNotificationCounts, markAllNotificationsRead, markNotificationsRead } from '@/server/notifications';

/**
 * POST /api/notifications/read — `{ ids: [uuid, …] }` marks these notifications of the signed-in
 * account as read (another account's ids are left untouched and not counted), `{ all: true }` marks
 * every unread notification of the account. Returns the number changed and the new counts.
 */

export const dynamic = 'force-dynamic';

const bodySchema = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(200) }),
  z.object({ all: z.literal(true) }),
]);

export const POST = apiRoute({
  auth: 'user',
  body: bodySchema,
  handler: async ({ body, user }) => {
    const updated = 'all' in body ? await markAllNotificationsRead(user.id) : await markNotificationsRead(user.id, body.ids);
    return { updated, counts: await getNotificationCounts(user.id) };
  },
});
