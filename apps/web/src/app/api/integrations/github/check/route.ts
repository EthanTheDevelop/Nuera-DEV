import { checkGithub } from '@/server/github';
import { apiRoute } from '@/server/http';

/**
 * POST /api/integrations/github/check — « Vérifier la connexion » (D07) of every GitHub source of
 * the space (or of the fallback token of the default server's space). Non-mutating diagnostic (app
 * JWT, installations, one token per installation, permissions, repository counts). Repeated calls
 * within 10 s return the last result. One source: /api/integrations/github/sources/[sourceId]/check.
 */

export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  rateLimit: { limit: 20, windowMs: 60_000 },
  handler: async ({ ctx, user }) => checkGithub({ spaceId: ctx.space.id, trigger: 'manual', actorUserId: user.id }),
});
