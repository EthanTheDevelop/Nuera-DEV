import { z } from 'zod';
import { deleteSkill, getSkillDetail, updateSkillMeta } from '@/server/claude-config';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/**
 *   GET    → { skill, files: [{ path, content, executable }] }
 *   PATCH  { description?, enabled?, audience?, enforcement?, allowScripts?, expectedVersion? } → { skill }
 *   DELETE → 204 (removed from every server at their next synchronisation; restorable from the history)
 */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({ auth: 'admin', params: idParams, handler: async ({ user, params }) => getSkillDetail(user, params.id) });

export const PATCH = apiRoute({
  auth: 'admin',
  params: idParams,
  body: z.unknown(),
  maxBodyBytes: 16 * 1024,
  handler: async ({ user, params, body }) => ({ skill: await updateSkillMeta(user, params.id, body) }),
});

export const DELETE = apiRoute({
  auth: 'admin',
  params: idParams,
  handler: async ({ user, params }) => {
    await deleteSkill(user, params.id);
  },
});
