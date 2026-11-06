import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { sessionIdParamsSchema, stopSession } from '@/server/sessions';

/**
 * POST /api/sessions/[sessionId]/stop { force? } — « Arrêter la session » (T8 in the UI): Échap,
 * `/exit`, then the runner stops the process. 409 when nothing runs. → { session, workspaceUrl }.
 * Audited `session.stop`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({ force: z.boolean().optional() }).strict().optional();

export const POST = apiRoute({
  params: sessionIdParamsSchema,
  body: bodySchema,
  maxBodyBytes: 1024,
  rateLimit: { limit: 60, windowMs: 10 * 60_000 },
  handler: async ({ params, body, ctx }) => stopSession(ctx, params.sessionId, { force: body?.force ?? false }),
});
