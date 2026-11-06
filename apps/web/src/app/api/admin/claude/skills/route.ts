import { z } from 'zod';
import { createSkillFromEditor } from '@/server/claude-config';
import { apiRoute } from '@/server/http';

/**
 * POST { name, skillMd, files?: [{ path, content }], enabled?, audience?, enforcement?, allowScripts? }
 *   → { skill, scripts, created } — « Nouveau skill » from the editor (same validation as an import).
 */
export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  auth: 'admin',
  body: z.unknown(),
  maxBodyBytes: 3 * 1024 * 1024,
  handler: async ({ user, body }) => createSkillFromEditor(user, body),
});
