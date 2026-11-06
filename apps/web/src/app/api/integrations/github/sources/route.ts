import { getGithubOverview } from '@/server/github';
import { startManifestResponse } from '@/server/github/flow';
import { apiRoute } from '@/server/http';

/**
 * GET  /api/integrations/github/sources — the GitHub sources of the space (one tile each in D07):
 *      `{ sources, sourceCount, maxSources, canAddSource }`. Never a secret.
 * POST /api/integrations/github/sources — « Ajouter une source GitHub »: same form as
 *      POST /api/integrations/github/manifest (`organization`, `public`), answered by the page that
 *      posts the manifest of a new app (unique name, private unless `public`) to github.com.
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  handler: async ({ ctx }) => {
    const overview = await getGithubOverview(ctx.space.id);
    return {
      sources: overview.sources,
      sourceCount: overview.sourceCount,
      maxSources: overview.maxSources,
      canAddSource: overview.canAddSource,
    };
  },
});

export const POST = apiRoute({
  rateLimit: { limit: 10, windowMs: 10 * 60_000 },
  handler: async ({ request, ctx }) => startManifestResponse(request, ctx),
});
