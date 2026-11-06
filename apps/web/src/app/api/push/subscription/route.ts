import { z } from 'zod';
import { AppError } from '@/server/errors';
import { apiRoute } from '@/server/http';
import {
  deleteSubscription,
  deleteSubscriptionById,
  getPushStatus,
  isEndpointSharedWithOtherAccount,
  isEndpointSubscribed,
  listPushDevices,
  pushEndpointSchema,
  pushSubscriptionInputSchema,
  upsertSubscription,
} from '@/server/push';
import { audit } from '@/server/security/audit';
import { getUserAgent } from '@/server/security/request-info';

/**
 * Web Push subscription of THIS device for the signed-in account (M08 « Notifications sur ce
 * téléphone »). One row per account and device: a browser shared by two accounts holds one row for
 * each, and `sharedWithOtherAccount` says so (« Ce navigateur reçoit aussi les notifications d'un
 * autre compte Nuera Dev. », never which one).
 *   GET    [?endpoint=]  → { enabled, reason, subscribed, sharedWithOtherAccount, devices }
 *   POST   { endpoint, keys: { p256dh, auth }, expirationTime?, deviceLabel? } → { id, deviceLabel, sharedWithOtherAccount }
 *   DELETE { endpoint } | { id } → { deleted, sharedWithOtherAccount }
 * The JSON is exactly `PushSubscription.toJSON()` (+ optional `deviceLabel`). Another account's
 * device id answers like an unknown one (`deleted: false`, nothing written, no audit).
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  auth: 'user',
  query: z.object({ endpoint: z.url().max(2048).optional() }),
  handler: async ({ query, user }) => {
    const status = getPushStatus();
    return {
      enabled: status.enabled,
      reason: status.reason,
      subscribed: query.endpoint ? await isEndpointSubscribed(user.id, query.endpoint) : null,
      sharedWithOtherAccount: query.endpoint ? await isEndpointSharedWithOtherAccount(user.id, query.endpoint) : null,
      devices: await listPushDevices(user.id),
    };
  },
});

export const POST = apiRoute({
  auth: 'user',
  body: pushSubscriptionInputSchema,
  rateLimit: { limit: 20, windowMs: 10 * 60_000 },
  handler: async ({ body, user, request }) => {
    const status = getPushStatus();
    if (!status.enabled) throw new AppError('CONFLICT', status.reason ?? 'Notifications push indisponibles.');
    const saved = await upsertSubscription(user.id, body, { authSessionId: user.authSessionId, userAgent: getUserAgent(request.headers) });
    await audit({
      action: 'security.push_subscribed',
      summary: `notifications push activées sur ${saved.deviceLabel ?? 'un appareil'}`,
      targetType: 'push_subscription',
      targetId: saved.id,
      actorUserId: user.id,
      actorLabel: user.email,
      subjectUserId: user.id,
    });
    return Response.json(saved, { status: 201, headers: { 'cache-control': 'no-store' } });
  },
});

export const DELETE = apiRoute({
  auth: 'user',
  body: z.union([z.object({ endpoint: pushEndpointSchema }), z.object({ id: z.uuid() })]),
  handler: async ({ body, user }) => {
    const deleted = 'id' in body ? await deleteSubscriptionById(user.id, body.id) : await deleteSubscription(user.id, body.endpoint);
    if (deleted) {
      await audit({
        action: 'security.push_unsubscribed',
        summary: 'notifications push désactivées sur un appareil',
        targetType: 'push_subscription',
        ...('id' in body ? { targetId: body.id } : {}),
        actorUserId: user.id,
        actorLabel: user.email,
        subjectUserId: user.id,
      });
    }
    // The browser keeps its push subscription while another account of this browser still uses it.
    const sharedWithOtherAccount = 'endpoint' in body ? await isEndpointSharedWithOtherAccount(user.id, body.endpoint) : false;
    return { deleted, sharedWithOtherAccount };
  },
});
