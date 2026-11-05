import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { setProjectMcpServer } from '@/server/mcp';

/**
 * PUT /api/integrations/mcp/[server]/projects/[projectId] — `{ enabled }`: D1 « ACTIVÉ DANS »
 * toggle and D04 « Outils MCP du projet ». Takes effect for the sessions started (or resumed)
 * afterwards: each session only receives the servers enabled for its project. Audited.
 */

export const dynamic = 'force-dynamic';

export const PUT = apiRoute({
  params: z.object({ server: z.string().min(1).max(64), projectId: z.uuid() }),
  body: z.object({ enabled: z.boolean() }),
  handler: async ({ params, body, user }) =>
    setProjectMcpServer({ projectId: params.projectId, serverIdOrName: params.server, enabled: body.enabled }, { actorUserId: user.id }),
});
