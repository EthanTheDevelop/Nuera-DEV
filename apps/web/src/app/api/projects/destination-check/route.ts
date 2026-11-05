import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { checkProjectDestination, repoFullNameSchema, withProjectErrors } from '@/server/projects';

/**
 * GET /api/projects/destination-check?chemin=/srv/dev/x&depot=owner/repo — live check of the D03
 * destination by the runner (never writes): available, file count, existing clone, suggested free
 * path, Nuera project already registered there.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  query: z.object({ chemin: z.string().trim().min(1).max(4096), depot: repoFullNameSchema.optional() }),
  rateLimit: { limit: 240, windowMs: 60_000 },
  handler: ({ query }) =>
    withProjectErrors(() => checkProjectDestination({ path: query.chemin, ...(query.depot ? { fullName: query.depot } : {}) })),
});
