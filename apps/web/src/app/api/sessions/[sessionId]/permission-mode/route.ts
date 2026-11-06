import { sessionParamsSchema } from '@/features/workspace/lib/contract';
import { permissionModeInputSchema } from '@/features/workspace/lib/composer';
import { apiRoute } from '@/server/http';
import { setSessionPermissionMode, withWorkspaceErrors } from '@/server/workspace';

/**
 * POST /api/sessions/[sessionId]/permission-mode { mode } — mode chip of the composer: Maj+Tab sent
 * to the live CLI until its screen shows the mode (bounded; `manual`, `acceptEdits`, `plan`, `auto`
 * only — the mode without permission is never switched to from here), else the
 * `--permission-mode` of the next launch. Audited `session.permission_mode`.
 * → { session, applied, presses, mode }
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: sessionParamsSchema,
  body: permissionModeInputSchema,
  rateLimit: { limit: 30, windowMs: 10 * 60_000 },
  handler: ({ params, body, ctx }) =>
    withWorkspaceErrors(() => setSessionPermissionMode(ctx, params.sessionId, body.mode)),
});
