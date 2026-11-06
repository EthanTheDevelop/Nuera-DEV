import { z } from 'zod';
import { updateSkillContent } from '@/server/claude-config';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../../_params';

/** PUT { skillMd, files?, allowScripts?, expectedVersion? } → { skill, scripts, created: false } (new version) */
export const dynamic = 'force-dynamic';

export const PUT = apiRoute({
  auth: 'admin',
  params: idParams,
  body: z.unknown(),
  maxBodyBytes: 3 * 1024 * 1024,
  handler: async ({ user, params, body }) => updateSkillContent(user, params.id, body),
});
