import { addServerAccount, assignServerSchema } from '@/server/admin';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/**
 * POST { userId } → { server } — shared servers (lot P1): one more account works on a server in
 * service, with its own space and its own Claude Code connection (journal `admin.server_account_added`).
 */
export const POST = apiRoute({
  auth: 'admin',
  params: idParams,
  body: assignServerSchema,
  maxBodyBytes: 1024,
  handler: async ({ user, params, body }) => ({ server: await addServerAccount(user, params.id, body) }),
});
