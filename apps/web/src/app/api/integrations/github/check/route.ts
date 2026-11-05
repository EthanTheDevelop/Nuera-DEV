import { checkGithub } from '@/server/github';
import { apiRoute } from '@/server/http';

/**
 * POST /api/integrations/github/check — « Vérifier la connexion » (D07). Non-mutating diagnostic
 * (app JWT, installations, one token per installation, permissions, repository counts). Repeated
 * calls within 10 s return the last result.
 */

export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  rateLimit: { limit: 20, windowMs: 60_000 },
  handler: async ({ user }) => checkGithub({ trigger: 'manual', actorUserId: user.id }),
});
