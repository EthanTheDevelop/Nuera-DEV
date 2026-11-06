import { eventsQuerySchema, sessionParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { getSessionEventsPage, withWorkspaceErrors } from '@/server/workspace';

/**
 * GET /api/sessions/[sessionId]/events?afterVersion= — conversation items changed after a version
 * (all of them with 0): reload after `stream.reset`, catch-up after a lost connection (W7).
 * → { items, version, complete }
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: sessionParamsSchema,
  query: eventsQuerySchema,
  handler: ({ params, query, ctx }) => withWorkspaceErrors(() => getSessionEventsPage(ctx, params.sessionId, query.afterVersion)),
});
