import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { restoreProject, withProjectErrors } from '@/server/projects';

/** POST /api/projects/[projectId]/restore — « Restaurer » an archived project (audited). */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: z.object({ projectId: z.uuid() }),
  handler: ({ params: { projectId }, user }) => withProjectErrors(() => restoreProject(projectId, user)),
});
