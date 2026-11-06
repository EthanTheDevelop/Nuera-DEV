import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { presetServerOf } from '@/server/integrations';
import { setProjectMcpServer } from '@/server/mcp';

/**
 * PUT /api/integrations/mcp/[server]/projects/[projectId] — `{ enabled }`: D1 « ACTIVÉ DANS »
 * toggle and D04 « Outils MCP du projet ». The project and the server must both belong to the space
 * (otherwise 404, as for an unknown id). Takes effect for the sessions started (or resumed)
 * afterwards: each session only receives the servers enabled for its project. Audited.
 */

export const dynamic = 'force-dynamic';

export const PUT = apiRoute({
  params: z.object({ server: z.string().min(1).max(64), projectId: z.uuid() }),
  body: z.object({ enabled: z.boolean() }),
  handler: async ({ params, body, ctx, user }) =>
    setProjectMcpServer(
      { spaceId: ctx.space.id, projectId: params.projectId, serverIdOrName: params.server, enabled: body.enabled },
      { actorUserId: user.id, server: presetServerOf(ctx) },
    ),
});
