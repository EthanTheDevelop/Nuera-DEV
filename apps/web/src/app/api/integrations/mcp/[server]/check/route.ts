import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { checkMcpServer } from '@/server/mcp';

/**
 * POST /api/integrations/mcp/[server]/check — « Tester la connexion » (D1) of a server of the space.
 * Non-mutating: `initialize` + `tools/list` for HTTP servers, `claude mcp get` (through the runner
 * of the space's server) for OAuth and stdio servers. Repeated calls within 10 s return the last
 * result. Another space's server answers like an unknown one.
 */

export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  params: z.object({ server: z.string().min(1).max(64) }),
  rateLimit: { limit: 30, windowMs: 60_000 },
  handler: async ({ params: { server }, ctx, user }) =>
    checkMcpServer({ spaceId: ctx.space.id, idOrName: server }, { trigger: 'manual', actorUserId: user.id }),
});
