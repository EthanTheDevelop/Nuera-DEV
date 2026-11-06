import { z } from 'zod';
import { getCoolifySettings } from '@/server/coolify';
import { apiRoute } from '@/server/http';
import { presetServerOf } from '@/server/integrations';
import { createMcpServer, createMcpServerInputSchema, listMcpServers } from '@/server/mcp';
import { syncMcpServersToCli } from '@/server/mcp/diagnostics';
import { getMcpServerRow, getProjectMcpTools } from '@/server/mcp/registry';

/**
 * MCP registry of the space:
 * GET  /api/integrations/mcp — MCP grid (D07): built-in servers (Figma, GitHub, Coolify, Playwright)
 *      and custom ones, with status, project activations and last diagnostic. No secret.
 *      `?projectId=` → D04 « Outils MCP du projet » (one line per server with its switch state; a
 *      project of another space answers like an unknown one).
 * POST /api/integrations/mcp — « Ajouter un serveur MCP »: custom HTTP (internal addresses refused,
 *      secret headers stored encrypted, served through the headers helper) or stdio server. Audited.
 *      Synced to Claude Code on the space's server (`cliSync`, best effort).
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  query: z.object({ projectId: z.uuid().optional() }),
  handler: async ({ query, ctx }) => {
    const coolify = await getCoolifySettings(ctx.space.id);
    const view = { coolifyBaseUrl: coolify.baseUrl, server: presetServerOf(ctx) };
    if (query.projectId) {
      return { projectId: query.projectId, tools: await getProjectMcpTools({ spaceId: ctx.space.id, projectId: query.projectId }, view) };
    }
    const servers = await listMcpServers({ spaceId: ctx.space.id, ...view });
    return { servers, total: servers.length };
  },
});

export const POST = apiRoute({
  body: createMcpServerInputSchema,
  rateLimit: { limit: 30, windowMs: 10 * 60_000 },
  handler: async ({ body, ctx, user }) => {
    const server = await createMcpServer(ctx.space.id, body, { actorUserId: user.id, server: presetServerOf(ctx) });
    const row = await getMcpServerRow({ spaceId: ctx.space.id, idOrName: server.id });
    // Servers diagnosed through `claude mcp get` need a user-scope entry (best effort).
    const sync = row ? await syncMcpServersToCli({ spaceId: ctx.space.id, upsert: [row] }) : null;
    return Response.json({ server, cliSync: sync }, { status: 201, headers: { 'cache-control': 'no-store' } });
  },
});
