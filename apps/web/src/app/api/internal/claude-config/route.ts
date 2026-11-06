import { CommonConfigRequestSchema } from '@nuera/shared/runner';
import { runnerPayload } from '@/server/claude-config';
import { internalRoute } from '@/server/http';

/**
 * POST /api/internal/claude-config — runner → web (Bearer token of its server).
 * The common Claude configuration of the CALLER'S server: rules (Markdown « Par défaut » and
 * « Imposé ») and skills that apply to the account of its space (audience, choices of the space).
 * The files of the skills listed in `have` with the same hash are omitted. A server not assigned to a
 * space receives an empty configuration; a suspended or retired one is refused (internalRoute, 403).
 * No secret inside: MCP credentials are only ever served by /api/internal/mcp-headers.
 *
 *   { have: [{ name, hash }] } → CommonConfigPayload (@nuera/shared/runner)
 */

export const dynamic = 'force-dynamic';

export const POST = internalRoute({
  body: CommonConfigRequestSchema,
  maxBodyBytes: 64 * 1024,
  handler: async ({ body, environment }) => Response.json(await runnerPayload(environment, body), { headers: { 'cache-control': 'no-store' } }),
});
