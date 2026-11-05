import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { disableMcpServerEverywhere } from '@/server/mcp';

/** POST /api/integrations/mcp/[server]/disable-all — D1 « Désactiver partout » (confirmed in the UI, audited). */

export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  params: z.object({ server: z.string().min(1).max(64) }),
  handler: async ({ params: { server }, user }) => disableMcpServerEverywhere(server, { actorUserId: user.id }),
});
