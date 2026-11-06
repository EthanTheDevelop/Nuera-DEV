import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { listNotifications } from '@/server/notifications';

/**
 * GET /api/notifications[?limit=&offset=&unread=1] — notification centre of the signed-in account
 * (bell, D01): unread first, then most recent; `counts` gives the badge (unread, by severity);
 * `nextOffset` paginates. Only this account's notifications, whatever space they come from.
 */

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
  unread: z.enum(['1', 'true', '0', 'false']).optional(),
});

export const GET = apiRoute({
  auth: 'user',
  query: querySchema,
  handler: async ({ query, user }) =>
    listNotifications(user.id, {
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
      unreadOnly: query.unread === '1' || query.unread === 'true',
    }),
});
