import { z } from 'zod';
import { internalRoute } from '@/server/http';
import { resolveSessionMcpHeaders } from '@/server/mcp';
import { requireCallerSession } from '@/server/tenancy/runner-scope';

/**
 * POST /api/internal/mcp-headers — runner → web (Bearer token of its server).
 * Called on behalf of bin/nuera-mcp-headers.mjs (Claude Code `headersHelper`) for one session of
 * the CALLER'S server. Refused unless the session exists on that server and is live, and the MCP
 * server (of the space of the session's project) is enabled for its project. A session of another
 * server answers like an unknown one (404) and is journalled (`security.runner_scope_violation`).
 * Credentials come from the session's space only (its registry, its Coolify, the project's GitHub
 * source). `serverUrl` (the URL Claude Code is about to call) must be that server's URL (403
 * otherwise): a credential is never handed out for another address.
 *
 *   { sessionId, serverName, serverUrl?, projectId? } → { headers: { Authorization: "Bearer …" }, expiresAt }
 */

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  sessionId: z.uuid(),
  serverName: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  serverUrl: z.string().max(2048).nullish(),
  projectId: z.uuid().nullish(),
});

export const POST = internalRoute({
  body: bodySchema,
  handler: async ({ body, environment }) => {
    await requireCallerSession(environment, body.sessionId, { route: 'mcp-headers', notFound: 'Session inconnue.' });
    const result = await resolveSessionMcpHeaders({
      sessionId: body.sessionId,
      serverName: body.serverName,
      environmentId: environment.id,
      serverUrl: body.serverUrl ?? null,
      projectId: body.projectId ?? null,
    });
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  },
});
