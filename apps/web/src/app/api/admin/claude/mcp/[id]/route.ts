import { z } from 'zod';
import { deleteInstanceMcp, updateInstanceMcp } from '@/server/claude-config';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/**
 *   PATCH  { label?, description?, audience?, enforcement?, enabled?, url?, baseUrl?, token?, … } → { server }
 *   DELETE → 204
 */
export const dynamic = 'force-dynamic';

export const PATCH = apiRoute({
  auth: 'admin',
  params: idParams,
  body: z.unknown(),
  maxBodyBytes: 64 * 1024,
  handler: async ({ user, params, body }) => ({ server: await updateInstanceMcp(user, params.id, body) }),
});

export const DELETE = apiRoute({
  auth: 'admin',
  params: idParams,
  handler: async ({ user, params }) => {
    await deleteInstanceMcp(user, params.id);
  },
});
