import { sessionParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { interruptSession, withWorkspaceErrors } from '@/server/workspace';

/**
 * POST /api/sessions/[sessionId]/interrupt — « Interrompre » / Échap: Échap sent to the CLI, the
 * current step stops and the session stays alive (W2). 409 when no CLI runs. → { status }
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: sessionParamsSchema,
  rateLimit: { limit: 120, windowMs: 10 * 60_000 },
  handler: ({ params, ctx }) => withWorkspaceErrors(() => interruptSession(ctx, params.sessionId)),
});
