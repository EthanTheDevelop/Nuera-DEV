import { apiRoute } from '@/server/http';
import { previewAutodebugInputSchema, requestPreviewAutodebug } from '@/server/preview';
import { withWorkspaceErrors } from '@/server/workspace';

/**
 * POST /api/previews/autodebug — { runId, sessionId, trigger: auto|manual, output? } → { delivered,
 * queued, status, queuedInstructions }: hands the output of a dev server that does not start to
 * Claude in the session (Aperçu « Demander à Claude de corriger automatiquement » / « Demander à
 * Claude »), once per run (409 `AUTODEBUG_ALREADY_SENT`), audited `preview.autodebug`. 409
 * `SESSION_BUSY_PERMISSION` while a permission waits, `AUTODEBUG_NOT_FAILED` when the server runs fine.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  body: previewAutodebugInputSchema,
  maxBodyBytes: 80 * 1024,
  rateLimit: { limit: 30, windowMs: 10 * 60_000 },
  handler: ({ body, ctx }) => withWorkspaceErrors(() => requestPreviewAutodebug(ctx, body)),
});
