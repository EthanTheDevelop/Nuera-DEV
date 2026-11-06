import { enableAccount } from '@/server/admin';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/**   POST → { account: AdminAccountView }: sign-in possible again, server active again. */
export const POST = apiRoute({
  auth: 'admin',
  params: idParams,
  handler: async ({ user, params }) => ({ account: await enableAccount(user, params.id) }),
});
