import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { archiveProject, getProjectDetail, patchProjectInputSchema, updateProject, withProjectErrors } from '@/server/projects';

/**
 * GET /api/projects/[projectId] — everything D04 / M04 shows (runner parts degrade on their own).
 * PATCH — { favorite?, name?, commands?, options? } (audited except the favourite star).
 * DELETE — archives the project (T8 « Archiver … ? »): ended sessions archived with it, GitHub
 * repository and clone untouched; 409 while a Claude session is live on it.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const params = z.object({ projectId: z.uuid() });

export const GET = apiRoute({
  params,
  handler: ({ params: { projectId } }) => withProjectErrors(() => getProjectDetail(projectId)),
});

export const PATCH = apiRoute({
  params,
  body: patchProjectInputSchema,
  maxBodyBytes: 16 * 1024,
  handler: ({ params: { projectId }, body, user }) => withProjectErrors(() => updateProject(projectId, body, user)),
});

export const DELETE = apiRoute({
  params,
  handler: ({ params: { projectId }, user }) => withProjectErrors(() => archiveProject(projectId, user)),
});
