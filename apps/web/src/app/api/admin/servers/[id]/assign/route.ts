import { assignServer, assignServerSchema } from '@/server/admin';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/**   POST { userId } → { server } (only a `pending` server, to an account without a server). */
export const POST = apiRoute({
  auth: 'admin',
  params: idParams,
  body: assignServerSchema,
  maxBodyBytes: 1024,
  handler: async ({ user, params, body }) => ({ server: await assignServer(user, params.id, body) }),
});
