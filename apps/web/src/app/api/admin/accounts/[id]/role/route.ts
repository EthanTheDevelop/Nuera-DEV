import { changeAccountRole, changeRoleSchema } from '@/server/admin';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/**   POST { role: 'admin' | 'member' } → { account } (owner never demoted, last admin protected, never oneself). */
export const POST = apiRoute({
  auth: 'admin',
  params: idParams,
  body: changeRoleSchema,
  maxBodyBytes: 1024,
  handler: async ({ user, params, body }) => ({ account: await changeAccountRole(user, params.id, body) }),
});
