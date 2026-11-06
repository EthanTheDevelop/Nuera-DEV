import { verifyServer } from '@/server/admin';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/**   POST → ServerVerification (GET /v1/health with the server's token: same server, state, contract). */
export const POST = apiRoute({
  auth: 'admin',
  params: idParams,
  handler: async ({ user, params }) => verifyServer(user, params.id),
});
