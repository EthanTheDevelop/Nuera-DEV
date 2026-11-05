import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { listNotifications } from '@/server/notifications';

/**
 * GET /api/notifications[?limit=&offset=&unread=1] — notification centre (bell, D01): unread first,
 * then most recent; `counts` gives the badge (unread, by severity); `nextOffset` paginates.
 */

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
  unread: z.enum(['1', 'true', '0', 'false']).optional(),
});

export const GET = apiRoute({
  query: querySchema,
  handler: async ({ query }) =>
    listNotifications({
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
      unreadOnly: query.unread === '1' || query.unread === 'true',
    }),
});
