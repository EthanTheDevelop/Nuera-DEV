import { sessionParamsSchema } from '@/features/workspace/lib/contract';
import { effortInputSchema } from '@/features/workspace/lib/composer';
import { apiRoute } from '@/server/http';
import { setSessionEffort, withWorkspaceErrors } from '@/server/workspace';

/**
 * POST /api/sessions/[sessionId]/effort { effort } — effort chip of the composer: `/effort <level>`
 * typed into the idle CLI by the runner (allowlisted command, confirmed on its screen), else the
 * `--effort` of the next launch (`auto`: none). Audited `session.effort`.
 * → { session, applied: 'live' | 'next_launch' }
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: sessionParamsSchema,
  body: effortInputSchema,
  rateLimit: { limit: 30, windowMs: 10 * 60_000 },
  handler: ({ params, body, ctx }) =>
    withWorkspaceErrors(() => setSessionEffort(ctx, params.sessionId, body.effort)),
});
