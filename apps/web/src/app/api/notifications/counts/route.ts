import { apiRoute } from '@/server/http';
import { getNotificationCounts } from '@/server/notifications';

/** GET /api/notifications/counts — `{ unread, total, unreadBySeverity }` of the signed-in account (bell badge). */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  auth: 'user',
  handler: async ({ user }) => getNotificationCounts(user.id),
});
