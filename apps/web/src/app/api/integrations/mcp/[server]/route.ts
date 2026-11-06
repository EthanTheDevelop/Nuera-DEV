import { z } from 'zod';
import { getCoolifySettings } from '@/server/coolify';
import { apiRoute } from '@/server/http';
import { presetServerOf } from '@/server/integrations';
import { deleteMcpServer, getMcpServer, updateMcpServer, updateMcpServerInputSchema } from '@/server/mcp';
import { syncMcpServersToCli } from '@/server/mcp/diagnostics';
import { getMcpServerRow } from '@/server/mcp/registry';

/**
 * One MCP server of the space (`[server]`: its name, `figma`, or its id; another space's answers
 * like an unknown one, 404 « Serveur MCP introuvable. »):
 * GET    — D1/D2 drawer: state, « ACTIVÉ DANS », permissions, configuration lines, last diagnostic
 *          and history (« Voir le journal »).
 * PATCH  — label, description, enabled flag; for custom servers also URL / command / secret headers
 *          (replaced, never returned; internal addresses refused).
 * DELETE — custom servers only (built-in ones are disabled instead).
 */

export const dynamic = 'force-dynamic';

const params = z.object({ server: z.string().min(1).max(64) });

export const GET = apiRoute({
  params,
  handler: async ({ params: { server }, ctx }) => {
    const coolify = await getCoolifySettings(ctx.space.id);
    return getMcpServer({ spaceId: ctx.space.id, idOrName: server }, { coolifyBaseUrl: coolify.baseUrl, server: presetServerOf(ctx) });
  },
});

export const PATCH = apiRoute({
  params,
  body: updateMcpServerInputSchema,
  handler: async ({ params: { server }, body, ctx, user }) => {
    const updated = await updateMcpServer({ spaceId: ctx.space.id, idOrName: server }, body, { actorUserId: user.id, server: presetServerOf(ctx) });
    const row = await getMcpServerRow({ spaceId: ctx.space.id, idOrName: updated.id });
    if (row && (body.url !== undefined || body.command !== undefined || body.args !== undefined)) {
      await syncMcpServersToCli({ spaceId: ctx.space.id, upsert: [row] });
    }
    return updated;
  },
});

export const DELETE = apiRoute({
  params,
  handler: async ({ params: { server }, ctx, user }) => {
    const deleted = await deleteMcpServer({ spaceId: ctx.space.id, idOrName: server }, { actorUserId: user.id });
    const sync = await syncMcpServersToCli({ spaceId: ctx.space.id, remove: [deleted.name] });
    return { deleted: deleted.name, cliSync: sync };
  },
});
