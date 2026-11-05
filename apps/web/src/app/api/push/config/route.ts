import { apiRoute } from '@/server/http';
import { getPushStatus } from '@/server/push';

/**
 * GET /api/push/config — `{ enabled, publicKey, reason }`: the VAPID application server key for
 * `pushManager.subscribe()`, or why Web Push is unavailable (keys missing on the server).
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  handler: async () => getPushStatus(),
});
