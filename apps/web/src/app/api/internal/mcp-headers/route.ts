import { z } from 'zod';
import { internalRoute } from '@/server/http';
import { resolveSessionMcpHeaders } from '@/server/mcp';

/**
 * POST /api/internal/mcp-headers — runner → web (Bearer RUNNER_TOKEN).
 * Called on behalf of bin/nuera-mcp-headers.mjs (Claude Code `headersHelper`) for one session.
 * Refused unless the session exists and is live, and the server is enabled for its project.
 *
 *   { sessionId, serverName } → { headers: { Authorization: "Bearer …" }, expiresAt }
 */

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  sessionId: z.uuid(),
  serverName: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
});

export const POST = internalRoute({
  body: bodySchema,
  handler: async ({ body }) => {
    const result = await resolveSessionMcpHeaders(body);
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  },
});
