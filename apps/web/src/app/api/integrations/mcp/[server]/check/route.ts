import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { checkMcpServer } from '@/server/mcp';

/**
 * POST /api/integrations/mcp/[server]/check — « Tester la connexion » (D1). Non-mutating:
 * `initialize` + `tools/list` for HTTP servers, `claude mcp get` (through the runner) for OAuth
 * and stdio servers. Repeated calls within 10 s return the last result.
 */

export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  params: z.object({ server: z.string().min(1).max(64) }),
  rateLimit: { limit: 30, windowMs: 60_000 },
  handler: async ({ params: { server }, user }) => checkMcpServer(server, { trigger: 'manual', actorUserId: user.id }),
});
