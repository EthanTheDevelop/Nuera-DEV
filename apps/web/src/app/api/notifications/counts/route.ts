import { apiRoute } from '@/server/http';
import { getNotificationCounts } from '@/server/notifications';

/** GET /api/notifications/counts — `{ unread, total, unreadBySeverity }` (bell badge). */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  handler: async () => getNotificationCounts(),
});
