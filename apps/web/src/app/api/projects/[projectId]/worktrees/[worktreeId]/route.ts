import { QueryBooleanSchema } from '@nuera/shared/runner';
import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { previewWorktreeRemoval, removeProjectWorktree, withProjectErrors } from '@/server/projects';

/**
 * GET /api/projects/[projectId]/worktrees/[worktreeId] — T8 preview: the worktree, the uncommitted
 * files that would be lost, whether it can be removed (live session, primary clone).
 * DELETE ?force=1&deleteBranch=1 — removes it; without `force` a dirty worktree answers 409
 * WORKTREE_DIRTY (the dialog then asks for the typed confirmation). Audited.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const params = z.object({ projectId: z.uuid(), worktreeId: z.uuid() });

export const GET = apiRoute({
  params,
  handler: ({ params: { projectId, worktreeId } }) => withProjectErrors(() => previewWorktreeRemoval(projectId, worktreeId)),
});

export const DELETE = apiRoute({
  params,
  query: z.object({ force: QueryBooleanSchema.optional(), deleteBranch: QueryBooleanSchema.optional() }),
  rateLimit: { limit: 30, windowMs: 10 * 60_000 },
  handler: ({ params: { projectId, worktreeId }, query, user }) =>
    withProjectErrors(() =>
      removeProjectWorktree(projectId, worktreeId, { force: query.force ?? false, deleteBranch: query.deleteBranch ?? false }, user),
    ),
});
