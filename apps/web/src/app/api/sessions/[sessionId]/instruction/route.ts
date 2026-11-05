import { instructionInputSchema, sessionParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { sendInstruction, withWorkspaceErrors } from '@/server/workspace';

/**
 * POST /api/sessions/[sessionId]/instruction { text } — « Envoyer » (D05 composer, S1). Typed into the
 * official CLI by the runner (queued while a step runs or while the CLI starts; resumes a session
 * whose CLI is gone). 409 `SESSION_BUSY_PERMISSION` while a permission waits.
 * → { delivered, queued, started, resumed, status, queuedInstructions }
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: sessionParamsSchema,
  body: instructionInputSchema,
  maxBodyBytes: 512 * 1024,
  rateLimit: { limit: 120, windowMs: 10 * 60_000 },
  handler: ({ params, body, user }) => withWorkspaceErrors(() => sendInstruction(params.sessionId, body.text, user)),
});
