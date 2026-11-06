import { retireServer } from '@/server/admin';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/**   POST → { server } (refused while active projects live on it; never the default server). */
export const POST = apiRoute({
  auth: 'admin',
  params: idParams,
  handler: async ({ user, params }) => ({ server: await retireServer(user, params.id) }),
});
