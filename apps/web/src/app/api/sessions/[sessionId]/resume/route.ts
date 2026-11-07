import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { resumeSession, sessionIdParamsSchema } from '@/server/sessions';

/**
 * POST /api/sessions/[sessionId]/resume { context? } — « Reprendre » on the session's server: a
 * removed worktree is recreated from its branch, the conversation recorded by Claude Code is
 * reopened (`claude --resume`). When it is gone: 409 RESUME_CONTEXT_REQUIRED until the owner
 * answers « Reprendre avec le contexte » (`context: true` = a summary of the stored history as the
 * first instruction of a fresh CLI, `false` = none). → { session, workspaceUrl }. 409
 * CAPACITY_REACHED / SESSION_NOT_RESUMABLE from the runner. Audited `session.resume`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const resumeBodySchema = z.object({ context: z.boolean().optional() }).strict().optional();

export const POST = apiRoute({
  params: sessionIdParamsSchema,
  body: resumeBodySchema,
  rateLimit: { limit: 30, windowMs: 10 * 60_000 },
  handler: async ({ params, body, ctx }) => resumeSession(ctx, params.sessionId, body?.context === undefined ? {} : { context: body.context }),
});
