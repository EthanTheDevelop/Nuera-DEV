import { requireUserForApi, type CurrentUser } from '@/server/auth/session';
import { AppError } from '@/server/errors';
import { apiRoute } from '@/server/http';
import { getPushStatus, pushRenewalInputSchema, renewSubscription } from '@/server/push';
import { audit } from '@/server/security/audit';

/**
 * Renewal of a push subscription by the service worker (`pushsubscriptionchange`, public/sw.js,
 * which sends the cookies of the browser) — docs/MULTICOMPTE.md §9.
 *   GET  → { enabled, publicKey } (VAPID application server key, public by design) when the old
 *          subscription does not carry it. No session needed.
 *   POST { oldEndpoint, subscription } → 204, whatever happened: only the row of the account signed
 *          in on this browser moves to the new endpoint and keys. Knowing an endpoint is no proof
 *          (every account of a shared browser can read it): another account's rows are never
 *          touched, and without a session nothing is written (the account turns notifications on
 *          again at its next visit). Origin checked, rate-limited per IP.
 */

export const dynamic = 'force-dynamic';

/** The signed-in account allowed to subscribe (same rule as POST /api/push/subscription), or null. */
async function signedInAccount(): Promise<CurrentUser | null> {
  try {
    return await requireUserForApi();
  } catch (error) {
    if (error instanceof AppError) return null;
    throw error;
  }
}

export const GET = apiRoute({
  auth: false,
  rateLimit: { limit: 30, windowMs: 10 * 60_000 },
  handler: async () => {
    const status = getPushStatus();
    return { enabled: status.enabled, publicKey: status.enabled ? status.publicKey : null };
  },
});

export const POST = apiRoute({
  auth: false,
  body: pushRenewalInputSchema,
  rateLimit: { limit: 10, windowMs: 10 * 60_000 },
  handler: async ({ body, ip }) => {
    const user = await signedInAccount();
    const renewed = user ? await renewSubscription(user.id, body.oldEndpoint, body.subscription) : 0;
    if (user && renewed > 0) {
      await audit({
        action: 'security.push_renewed',
        summary: 'abonnement push renouvelé par le navigateur',
        targetType: 'push_subscription',
        actorUserId: user.id,
        actorLabel: user.email,
        subjectUserId: user.id,
        ip,
      });
    }
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  },
});
