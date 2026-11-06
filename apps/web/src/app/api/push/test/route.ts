import { AppError } from '@/server/errors';
import { apiRoute } from '@/server/http';
import { getPushStatus, sendPush } from '@/server/push';

/**
 * POST /api/push/test — sends a test notification to the devices of the signed-in account (never another account's) (M08 check that
 * « Notifications sur ce téléphone » works). Returns `{ sent, pruned, failed, skipped }`.
 */

export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  auth: 'user',
  rateLimit: { limit: 5, windowMs: 10 * 60_000 },
  handler: async ({ user }) => {
    const status = getPushStatus();
    if (!status.enabled) throw new AppError('CONFLICT', status.reason ?? 'Notifications push indisponibles.');
    return sendPush(
      {
        title: 'Notifications activées',
        body: 'Nuera Dev vous préviendra ici quand une session attend votre accord ou se termine.',
        url: '/',
        tag: 'push-test',
        severity: 'info',
        kind: 'server',
      },
      { userIds: [user.id] },
    );
  },
});
