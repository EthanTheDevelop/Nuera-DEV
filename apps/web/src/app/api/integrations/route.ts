import { apiRoute } from '@/server/http';
import { getIntegrationsOverview } from '@/server/integrations';

/**
 * GET /api/integrations — everything the Intégrations page (D07/M07) and the Accueil tile (D01)
 * show for the space of the account: GitHub sources, MCP grid with project counts, Coolify state,
 * diagnostic banners, guardrails, Web Push availability. Read from the database (no network call);
 * no secret; nothing of another space.
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  handler: async ({ ctx }) => getIntegrationsOverview(ctx),
});
