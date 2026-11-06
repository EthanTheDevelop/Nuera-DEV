import { z } from 'zod';
import { deleteRule, updateRule } from '@/server/claude-config';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/**
 *   PATCH  { title?, body?, enabled?, audience?, enforcement?, expectedVersion? } → { rule } (new version)
 *   DELETE → 204 (a « deleted » version is kept: the rule can be restored from the history)
 */
export const dynamic = 'force-dynamic';

export const PATCH = apiRoute({
  auth: 'admin',
  params: idParams,
  body: z.unknown(),
  maxBodyBytes: 64 * 1024,
  handler: async ({ user, params, body }) => ({ rule: await updateRule(user, params.id, body) }),
});

export const DELETE = apiRoute({
  auth: 'admin',
  params: idParams,
  handler: async ({ user, params }) => {
    await deleteRule(user, params.id);
  },
});
