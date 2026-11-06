import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { checkProjectDestination, repoFullNameSchema, withProjectErrors } from '@/server/projects';

/**
 * GET /api/projects/destination-check?chemin=/srv/dev/x&depot=owner/repo — live check of the D03
 * destination by the runner of the space's server (never writes): available, file count, existing
 * clone, suggested free path, project of the space already registered there. 409 NO_ENVIRONMENT
 * while no server is assigned.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  query: z.object({ chemin: z.string().trim().min(1).max(4096), depot: repoFullNameSchema.optional() }),
  rateLimit: { limit: 240, windowMs: 60_000 },
  handler: ({ query, ctx }) =>
    withProjectErrors(() => checkProjectDestination(ctx, { path: query.chemin, ...(query.depot ? { fullName: query.depot } : {}) })),
});
