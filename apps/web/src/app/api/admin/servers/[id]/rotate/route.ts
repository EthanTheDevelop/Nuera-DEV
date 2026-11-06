import { rotateServerToken } from '@/server/admin';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/**   POST → RotatedToken (`token` shown once; the old one works until the runner uses the new one). */
export const POST = apiRoute({
  auth: 'admin',
  params: idParams,
  handler: async ({ user, params }) => rotateServerToken(user, params.id),
});
