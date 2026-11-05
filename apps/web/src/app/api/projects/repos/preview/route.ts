import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { getRepoPreview, repoFullNameSchema, withProjectErrors } from '@/server/projects';

/**
 * GET /api/projects/repos/preview?depot=owner/repo — D03 « Configuration »: branches, visibility,
 * language, size, CLAUDE.md / lockfile when GitHub serves the root, default destination checked by
 * the runner, free disk space.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  query: z.object({ depot: repoFullNameSchema }),
  rateLimit: { limit: 60, windowMs: 60_000 },
  handler: ({ query }) => withProjectErrors(() => getRepoPreview(query.depot)),
});
