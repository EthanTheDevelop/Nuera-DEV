import { z } from 'zod';
import { createRule } from '@/server/claude-config';
import { apiRoute } from '@/server/http';

/** POST { title, body, enabled?, audience?, enforcement? } → { rule } (version 1, journal instance.claude_rule_created) */
export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  auth: 'admin',
  body: z.unknown(),
  maxBodyBytes: 64 * 1024,
  handler: async ({ user, body }) => ({ rule: await createRule(user, body) }),
});
