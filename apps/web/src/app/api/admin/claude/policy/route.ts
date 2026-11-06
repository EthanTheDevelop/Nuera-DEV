import { z } from 'zod';
import { updatePolicy } from '@/server/claude-config';
import { apiRoute } from '@/server/http';

/**
 * PATCH { allow?, ask?, deny?: [{ id?, rule, enforcement, note? }], env?: [{ id?, name, value, enforcement }],
 *         defaultModel?, modelEnforcement?, expectedVersion? } → { policy }
 * Each list given replaces the stored one. Secret-looking variable names are refused.
 */
export const dynamic = 'force-dynamic';

export const PATCH = apiRoute({
  auth: 'admin',
  body: z.unknown(),
  maxBodyBytes: 128 * 1024,
  handler: async ({ user, body }) => ({ policy: await updatePolicy(user, body) }),
});
