import { z } from 'zod';
import { reorderRules } from '@/server/claude-config';
import { apiRoute } from '@/server/http';

/** POST { ids: [ruleId…] } (every rule, in the new order) → { rules } */
export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  auth: 'admin',
  body: z.unknown(),
  maxBodyBytes: 32 * 1024,
  handler: async ({ user, body }) => ({ rules: await reorderRules(user, body) }),
});
