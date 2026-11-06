import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { disableMcpServerEverywhere } from '@/server/mcp';

/** POST /api/integrations/mcp/[server]/disable-all — D1 « Désactiver partout » in the projects of the space (confirmed in the UI, audited). */

export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  params: z.object({ server: z.string().min(1).max(64) }),
  handler: async ({ params: { server }, ctx, user }) =>
    disableMcpServerEverywhere({ spaceId: ctx.space.id, idOrName: server }, { actorUserId: user.id }),
});
