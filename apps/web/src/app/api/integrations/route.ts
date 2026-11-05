import { apiRoute } from '@/server/http';
import { getIntegrationsOverview } from '@/server/integrations';

/**
 * GET /api/integrations — everything the Intégrations page (D07/M07) and the Accueil tile (D01)
 * show: GitHub card, MCP grid with project counts, Coolify state, diagnostic banners, guardrails,
 * Web Push availability. Read from the database (no network call); no secret.
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  handler: async () => getIntegrationsOverview(),
});
