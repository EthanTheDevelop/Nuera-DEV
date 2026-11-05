import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { getArchivePreview, withProjectErrors } from '@/server/projects';

/** GET /api/projects/[projectId]/archive — what the T8 archive dialog lists (ended / live sessions). */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: z.object({ projectId: z.uuid() }),
  handler: ({ params: { projectId } }) => withProjectErrors(() => getArchivePreview(projectId)),
});
