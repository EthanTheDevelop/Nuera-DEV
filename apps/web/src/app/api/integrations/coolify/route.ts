import { disconnectCoolify, getCoolifySettings, reconnectCoolify, reconnectCoolifyInputSchema } from '@/server/coolify';
import { apiRoute } from '@/server/http';
import { checkMcpServer } from '@/server/mcp';

/**
 * Coolify of the space (one token per space):
 * GET    /api/integrations/coolify — state (fingerprint « jeton n°67 », scope, abilities, visible
 *        environments, last check). Never the token.
 * PUT    /api/integrations/coolify — D2 « Reconnecter »: `{ token, baseUrl?, expiresAt?, allowProductionVisible? }`.
 *        Internal addresses are refused (SSRF guard). Validated with GET calls only (health, version,
 *        team, environments, MCP tools/list), stored encrypted, audited. On refusal the previous token
 *        is kept (`untouched`). On success the space's Coolify MCP server is re-tested with the new
 *        token (`mcp`: its new status), so the card and the banner of Intégrations reflect it at once.
 * DELETE /api/integrations/coolify — removes the stored token (audited).
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  handler: async ({ ctx }) => getCoolifySettings(ctx.space.id),
});

export const PUT = apiRoute({
  body: reconnectCoolifyInputSchema,
  rateLimit: { limit: 10, windowMs: 10 * 60_000 },
  handler: async ({ body, ctx, user }) => {
    const result = await reconnectCoolify(ctx.space.id, body, { actorUserId: user.id });
    const mcp = await checkMcpServer({ spaceId: ctx.space.id, idOrName: 'coolify' }, { trigger: 'setup' }).catch(() => null);
    return { ...result, mcp: mcp ? { status: mcp.status, badge: mcp.badge } : null };
  },
});

export const DELETE = apiRoute({
  handler: async ({ ctx, user }) => ({ deleted: await disconnectCoolify({ spaceId: ctx.space.id, actorUserId: user.id }) }),
});
