import { z } from 'zod';
import { getCoolifySettings } from '@/server/coolify';
import { apiRoute } from '@/server/http';
import { createMcpServer, createMcpServerInputSchema, listMcpServers } from '@/server/mcp';
import { syncMcpServersToCli } from '@/server/mcp/diagnostics';
import { getMcpServerRow, getProjectMcpTools } from '@/server/mcp/registry';

/**
 * GET  /api/integrations/mcp — MCP grid (D07): built-in servers (Figma, GitHub, Coolify, Playwright)
 *      and custom ones, with status, project activations and last diagnostic. No secret.
 *      `?projectId=` → D04 « Outils MCP du projet » (one line per server with its switch state).
 * POST /api/integrations/mcp — « Ajouter un serveur MCP »: custom HTTP (secret headers stored
 *      encrypted, served through the headers helper) or stdio server. Audited.
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  query: z.object({ projectId: z.uuid().optional() }),
  handler: async ({ query }) => {
    const coolify = await getCoolifySettings();
    if (query.projectId) {
      return { projectId: query.projectId, tools: await getProjectMcpTools(query.projectId, { coolifyBaseUrl: coolify.baseUrl }) };
    }
    const servers = await listMcpServers({ coolifyBaseUrl: coolify.baseUrl });
    return { servers, total: servers.length };
  },
});

export const POST = apiRoute({
  body: createMcpServerInputSchema,
  rateLimit: { limit: 30, windowMs: 10 * 60_000 },
  handler: async ({ body, user }) => {
    const server = await createMcpServer(body, { actorUserId: user.id });
    const row = await getMcpServerRow(server.id);
    // Servers diagnosed through `claude mcp get` need a user-scope entry (best effort).
    const sync = row ? await syncMcpServersToCli({ upsert: [row] }) : null;
    return Response.json({ server, cliSync: sync }, { status: 201, headers: { 'cache-control': 'no-store' } });
  },
});
