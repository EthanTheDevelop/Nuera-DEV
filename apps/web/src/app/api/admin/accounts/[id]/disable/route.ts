import { disableAccount, disableAccountSchema } from '@/server/admin';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/**
 *   POST { stopSessions?: boolean = true } → DisableAccountResult: web accesses, trusted devices and
 *   push subscriptions deleted, server suspended, Claude Code sessions stopped (option).
 */
export const POST = apiRoute({
  auth: 'admin',
  params: idParams,
  body: disableAccountSchema.optional(),
  maxBodyBytes: 1024,
  handler: async ({ user, params, body }) => disableAccount(user, params.id, body ?? {}),
});
