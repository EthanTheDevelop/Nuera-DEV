import { createAccountRecoveryLink, recoverySchema } from '@/server/admin';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/**
 *   POST { password, removePasskeys? } → RecoveryLinkView { url, expiresAt } — the administrator's
 *   password is asked again; the account's accesses, trusted devices and second factor are closed;
 *   the link is shown once.
 */
export const POST = apiRoute({
  auth: 'admin',
  params: idParams,
  body: recoverySchema,
  maxBodyBytes: 2048,
  handler: async ({ user, params, body }) => createAccountRecoveryLink(user, params.id, body),
});
