import { sessionParamsSchema } from '@/features/workspace/lib/contract';
import { modelInputSchema } from '@/features/workspace/lib/composer';
import { apiRoute } from '@/server/http';
import { setSessionModel, withWorkspaceErrors } from '@/server/workspace';

/**
 * POST /api/sessions/[sessionId]/model { model } — model chip of the composer: `/model <alias>`
 * typed into the idle CLI by the runner (allowlisted command, confirmed on its screen), else the
 * `--model` of the next launch. Audited `session.model`. → { session, applied: 'live' | 'next_launch' }
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: sessionParamsSchema,
  body: modelInputSchema,
  rateLimit: { limit: 30, windowMs: 10 * 60_000 },
  handler: ({ params, body, ctx }) =>
    withWorkspaceErrors(() => setSessionModel(ctx, params.sessionId, body.model)),
});
