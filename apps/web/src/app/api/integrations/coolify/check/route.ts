import { checkCoolify } from '@/server/coolify';
import { apiRoute } from '@/server/http';

/** POST /api/integrations/coolify/check — Coolify of the space: health → version → declared expiry (GET only). */

export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  rateLimit: { limit: 20, windowMs: 60_000 },
  handler: async ({ ctx }) => checkCoolify({ spaceId: ctx.space.id, trigger: 'manual' }),
});
