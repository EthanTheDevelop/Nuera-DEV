import { z } from 'zod';
import { AppError } from '@/server/errors';
import { apiRoute } from '@/server/http';
import {
  deletePushSubscription,
  getPushStatus,
  isEndpointSubscribed,
  listPushDevices,
  pushSubscriptionInputSchema,
  savePushSubscription,
} from '@/server/push';
import { audit } from '@/server/security/audit';
import { getUserAgent } from '@/server/security/request-info';

/**
 * Web Push subscription of THIS device (M08 « Notifications sur ce téléphone »).
 *   GET    [?endpoint=]  → { enabled, reason, subscribed, devices }
 *   POST   { endpoint, keys: { p256dh, auth }, expirationTime?, deviceLabel? } → { id, deviceLabel }
 *   DELETE { endpoint } | { id } → { deleted }
 * The JSON is exactly `PushSubscription.toJSON()` (+ optional `deviceLabel`).
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  query: z.object({ endpoint: z.url().max(2048).optional() }),
  handler: async ({ query, user }) => {
    const status = getPushStatus();
    return {
      enabled: status.enabled,
      reason: status.reason,
      subscribed: query.endpoint ? await isEndpointSubscribed(user.id, query.endpoint) : null,
      devices: await listPushDevices(user.id),
    };
  },
});

export const POST = apiRoute({
  body: pushSubscriptionInputSchema,
  rateLimit: { limit: 20, windowMs: 10 * 60_000 },
  handler: async ({ body, user, request }) => {
    const status = getPushStatus();
    if (!status.enabled) throw new AppError('CONFLICT', status.reason ?? 'Notifications push indisponibles.');
    const saved = await savePushSubscription({ userId: user.id, subscription: body, userAgent: getUserAgent(request.headers) });
    await audit({
      action: 'security.push_subscribed',
      summary: `notifications push activées sur ${saved.deviceLabel ?? 'un appareil'}`,
      targetType: 'push_subscription',
      targetId: saved.id,
      actorUserId: user.id,
    });
    return Response.json(saved, { status: 201, headers: { 'cache-control': 'no-store' } });
  },
});

export const DELETE = apiRoute({
  body: z.union([z.object({ endpoint: z.url().max(2048) }), z.object({ id: z.uuid() })]),
  handler: async ({ body, user }) => {
    const deleted = await deletePushSubscription({ userId: user.id, ...body });
    if (deleted) {
      await audit({
        action: 'security.push_unsubscribed',
        summary: 'notifications push désactivées sur un appareil',
        targetType: 'push_subscription',
        ...('id' in body ? { targetId: body.id } : {}),
        actorUserId: user.id,
      });
    }
    return { deleted };
  },
});
