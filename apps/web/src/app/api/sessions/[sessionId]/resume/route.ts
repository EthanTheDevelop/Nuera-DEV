import { apiRoute } from '@/server/http';
import { resumeSession, sessionIdParamsSchema } from '@/server/sessions';

/**
 * POST /api/sessions/[sessionId]/resume — « Reprendre » (`claude --resume` in the session's
 * worktree, launch options rebuilt). → { session, workspaceUrl }. 409 CAPACITY_REACHED /
 * SESSION_NOT_RESUMABLE from the runner. Audited `session.resume`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: sessionIdParamsSchema,
  rateLimit: { limit: 30, windowMs: 10 * 60_000 },
  handler: async ({ params, ctx }) => resumeSession(ctx, params.sessionId),
});
