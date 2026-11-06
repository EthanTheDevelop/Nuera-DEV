import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { setProjectMcpTool, withProjectErrors } from '@/server/projects';

/**
 * PUT /api/projects/[projectId]/mcp/[server] — { enabled }: D04 « Outils MCP du projet » switch.
 * Takes effect for the sessions started or resumed afterwards; a server that needs a reconnection
 * is refused ON (409, reconnect in Intégrations). Audited.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PUT = apiRoute({
  params: z.object({ projectId: z.uuid(), server: z.string().min(1).max(64) }),
  body: z.object({ enabled: z.boolean() }),
  handler: ({ params, body, ctx }) => withProjectErrors(() => setProjectMcpTool(ctx, params.projectId, params.server, body.enabled)),
});
