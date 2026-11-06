import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { listProjectWorktrees, withProjectErrors } from '@/server/projects';

/** GET /api/projects/[projectId]/worktrees — worktrees with live data (dirty files, ahead/behind, live session). */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: z.object({ projectId: z.uuid() }),
  handler: ({ params: { projectId }, ctx }) => withProjectErrors(() => listProjectWorktrees(ctx, projectId)),
});
