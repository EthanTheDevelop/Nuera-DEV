import { getInstanceView, instancePatchSchema, updateInstance } from '@/server/admin';
import { apiRoute } from '@/server/http';

/**
 *   GET   → InstanceView (instance settings + warning about the default server's database access)
 *   PATCH { webSessionIdleHours?, webSessionMaxDays?, invitationTtlHours?, forceBlockBypassPermissions? }
 *         → { view, results } (any other key: 422)
 */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  auth: 'admin',
  handler: async ({ user }) => getInstanceView(user),
});

export const PATCH = apiRoute({
  auth: 'admin',
  body: instancePatchSchema,
  maxBodyBytes: 2048,
  handler: async ({ user, body }) => updateInstance(user, body),
});
