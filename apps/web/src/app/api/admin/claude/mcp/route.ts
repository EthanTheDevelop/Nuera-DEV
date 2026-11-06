import { z } from 'zod';
import { createInstanceMcp } from '@/server/claude-config';
import { apiRoute } from '@/server/http';

/**
 * POST { kind: 'custom' | 'stdio' | 'coolify', … } → { server } (secrets encrypted, never returned).
 * Coolify: `{ kind: 'coolify', baseUrl, token, allowWrite?, allowDestructive? }`, administrators only
 * (audience forced), served once a test listed its tools.
 */
export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  auth: 'admin',
  body: z.unknown(),
  maxBodyBytes: 64 * 1024,
  handler: async ({ user, body }) => ({ server: await createInstanceMcp(user, body) }),
});
