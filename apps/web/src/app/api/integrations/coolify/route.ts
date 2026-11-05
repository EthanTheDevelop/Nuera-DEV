import { disconnectCoolify, getCoolifySettings, reconnectCoolify, reconnectCoolifyInputSchema } from '@/server/coolify';
import { apiRoute } from '@/server/http';
import { checkMcpServer } from '@/server/mcp';

/**
 * GET    /api/integrations/coolify — Coolify state (fingerprint « jeton n°67 », scope, abilities,
 *        visible environments, last check). Never the token.
 * PUT    /api/integrations/coolify — D2 « Reconnecter »: `{ token, baseUrl?, expiresAt?, allowProductionVisible? }`.
 *        Validated with GET calls only (health, version, team, environments, MCP tools/list), stored
 *        encrypted, audited. On refusal the previous token is kept (`untouched`). On success the
 *        Coolify MCP server is re-tested with the new token (`mcp`: its new status), so the card and
 *        the diagnostic banner of Intégrations reflect the reconnection at once.
 * DELETE /api/integrations/coolify — removes the stored token (audited).
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  handler: async () => getCoolifySettings(),
});

export const PUT = apiRoute({
  body: reconnectCoolifyInputSchema,
  rateLimit: { limit: 10, windowMs: 10 * 60_000 },
  handler: async ({ body, user }) => {
    const result = await reconnectCoolify(body, { actorUserId: user.id });
    const mcp = await checkMcpServer('coolify', { trigger: 'setup' }).catch(() => null);
    return { ...result, mcp: mcp ? { status: mcp.status, badge: mcp.badge } : null };
  },
});

export const DELETE = apiRoute({
  handler: async ({ user }) => ({ deleted: await disconnectCoolify({ actorUserId: user.id }) }),
});
