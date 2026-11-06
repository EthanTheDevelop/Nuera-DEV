import { autoResumeInputSchema } from '@/features/sessions/lib/contract';
import { apiRoute } from '@/server/http';
import { resumeAfterLimitNow, sessionIdParamsSchema, setSessionAutoResume } from '@/server/sessions';
import { sendInstruction, withWorkspaceErrors } from '@/server/workspace';

/**
 * POST /api/sessions/[sessionId]/auto-resume — « Reprise automatique après la limite
 * d'utilisation » of one session of the space.
 *
 *   { enabled: true | false | null }   this session only (null = the space default); the runner of its
 *                                      server reschedules or cancels a limit in play.
 *                                      Audited `session.auto_resume_changed`.
 *   { resumeNow: true }                « Reprendre maintenant »: the instruction of reprise is typed
 *                                      now (resumes a CLI that is gone), the schedule is cancelled.
 *                                      409 when no limit stops the session. Audited `session.auto_resume_now`.
 *
 * → { session, workspaceUrl }. Another space's session answers like an unknown one (404).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: sessionIdParamsSchema,
  body: autoResumeInputSchema,
  maxBodyBytes: 4 * 1024,
  rateLimit: { limit: 60, windowMs: 10 * 60_000 },
  handler: async ({ params, body, ctx }) =>
    'resumeNow' in body
      ? withWorkspaceErrors(() => resumeAfterLimitNow(ctx, params.sessionId, (text) => sendInstruction(ctx, params.sessionId, text)))
      : setSessionAutoResume(ctx, params.sessionId, body.enabled),
});
