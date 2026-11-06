import { z } from 'zod';
import { setSpaceOverride } from '@/server/claude-config';
import { apiRoute } from '@/server/http';

/**
 * PATCH { key: 'rule:<id>' | 'skill:<id>' | 'mcp:<id>' | 'perm:<id>' | 'env:<id>', disabled } → { config }
 * Owner of the space only; « Imposé » items are refused (403), an item outside the account's audience
 * answers like an unknown one (404).
 */
export const dynamic = 'force-dynamic';

export const PATCH = apiRoute({
  body: z.unknown(),
  maxBodyBytes: 4096,
  handler: async ({ ctx, body }) => ({ config: await setSpaceOverride(ctx, body) }),
});
