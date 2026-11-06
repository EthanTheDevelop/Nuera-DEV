import { getServer, updateServer, updateServerSchema } from '@/server/admin';
import { apiRoute } from '@/server/http';
import { idParams } from '../../_params';

/**
 *   GET   → { server: AdminServerView }
 *   PATCH { name?, location?, url?, maxConcurrentSessionsCap?, password? } → { server, token }
 *     A new address of a server in use replaces its tokens: `token` is its new RUNNER_TOKEN, shown
 *     once (null otherwise). Another account's server: owner of the instance only, `password` required.
 */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  auth: 'admin',
  params: idParams,
  handler: async ({ user, params }) => ({ server: await getServer(user, params.id) }),
});

export const PATCH = apiRoute({
  auth: 'admin',
  params: idParams,
  body: updateServerSchema,
  maxBodyBytes: 2048,
  handler: async ({ user, params, body }) => updateServer(user, params.id, body),
});
