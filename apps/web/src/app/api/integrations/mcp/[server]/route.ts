import { z } from 'zod';
import { getCoolifySettings } from '@/server/coolify';
import { apiRoute } from '@/server/http';
import { deleteMcpServer, getMcpServer, updateMcpServer, updateMcpServerInputSchema } from '@/server/mcp';
import { syncMcpServersToCli } from '@/server/mcp/diagnostics';
import { getMcpServerRow } from '@/server/mcp/registry';

/**
 * GET    /api/integrations/mcp/[server] — one server (D1/D2 drawer): state, « ACTIVÉ DANS »,
 *        permissions, configuration lines, last diagnostic and history (« Voir le journal »).
 * PATCH  /api/integrations/mcp/[server] — label, description, enabled flag; for custom servers also
 *        URL / command / secret headers (replaced, never returned).
 * DELETE /api/integrations/mcp/[server] — custom servers only (built-in ones are disabled instead).
 * `[server]` is the server name (`figma`) or its id.
 */

export const dynamic = 'force-dynamic';

const params = z.object({ server: z.string().min(1).max(64) });

export const GET = apiRoute({
  params,
  handler: async ({ params: { server } }) => {
    const coolify = await getCoolifySettings();
    return getMcpServer(server, { coolifyBaseUrl: coolify.baseUrl });
  },
});

export const PATCH = apiRoute({
  params,
  body: updateMcpServerInputSchema,
  handler: async ({ params: { server }, body, user }) => {
    const updated = await updateMcpServer(server, body, { actorUserId: user.id });
    const row = await getMcpServerRow(updated.id);
    if (row && (body.url !== undefined || body.command !== undefined || body.args !== undefined)) {
      await syncMcpServersToCli({ upsert: [row] });
    }
    return updated;
  },
});

export const DELETE = apiRoute({
  params,
  handler: async ({ params: { server }, user }) => {
    const deleted = await deleteMcpServer(server, { actorUserId: user.id });
    const sync = await syncMcpServersToCli({ remove: [deleted.name] });
    return { deleted: deleted.name, cliSync: sync };
  },
});
