import { apiRoute } from '@/server/http';
import { archiveSession, sessionIdParamsSchema } from '@/server/sessions';

/** POST /api/sessions/[sessionId]/archive — same as DELETE /api/sessions/[sessionId] (archive, audited). */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: sessionIdParamsSchema,
  rateLimit: { limit: 60, windowMs: 10 * 60_000 },
  handler: async ({ params, user }) => archiveSession(params.sessionId, user),
});
