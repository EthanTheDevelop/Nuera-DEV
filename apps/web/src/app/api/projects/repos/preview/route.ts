import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { getRepoPreview, githubSourceIdSchema, repoFullNameSchema, withProjectErrors } from '@/server/projects';

/**
 * GET /api/projects/repos/preview?depot=owner/repo[&source=<id>] — D03 « Configuration »: branches,
 * visibility, language, size, CLAUDE.md / lockfile when GitHub serves the root (through the space's
 * GitHub source, `source` when the repository is reachable through several), default destination
 * checked by the space's runner, free disk space.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  query: z.object({ depot: repoFullNameSchema, source: githubSourceIdSchema.optional() }),
  rateLimit: { limit: 60, windowMs: 60_000 },
  handler: ({ query, ctx }) => withProjectErrors(() => getRepoPreview(ctx, query.depot, query.source ?? null)),
});
