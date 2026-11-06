import { z } from 'zod';
import { checkGithubSource } from '@/server/github';
import { apiRoute } from '@/server/http';

/**
 * POST /api/integrations/github/sources/[sourceId]/check — « Vérifier la connexion » of one GitHub
 * source of the space (non-mutating: app JWT, installations, one token per installation). Repeated
 * calls within 10 s return the last result. A source of another space answers like an unknown one.
 */

export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  params: z.object({ sourceId: z.string().min(1).max(64) }),
  rateLimit: { limit: 20, windowMs: 60_000 },
  handler: async ({ params: { sourceId }, ctx, user }) =>
    checkGithubSource({ spaceId: ctx.space.id, sourceId, trigger: 'manual', actorUserId: user.id }),
});
