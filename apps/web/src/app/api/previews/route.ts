import { apiRoute } from '@/server/http';
import { createPreviewHandoff, previewHandoffInputSchema } from '@/server/preview';

/**
 * POST /api/previews — { runId, path? } → { url, origin, expiresAt }: handoff to the preview origin
 * (« Aperçu ») for a live dev server of the account's space. `url` is single use and valid 60 s; it
 * sets the preview cookie on PREVIEW_HOST and redirects to `path`. A run of another space answers
 * « Lancement introuvable. » (404), before any runner call; PREVIEW_HOST empty → 409 PREVIEW_DISABLED.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  body: previewHandoffInputSchema,
  maxBodyBytes: 4 * 1024,
  rateLimit: { limit: 120, windowMs: 10 * 60_000 },
  handler: async ({ body, ctx }) => Response.json(await createPreviewHandoff(ctx, body), { headers: { 'cache-control': 'no-store' } }),
});
