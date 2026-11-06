import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { createBranchInputSchema, createProjectBranch, listProjectBranches, withProjectErrors } from '@/server/projects';

/**
 * GET /api/projects/[projectId]/branches — local branches (+ remote-only ones) with worktree, live
 * session, protected / merged flags. POST — { name, from?, checkout? } « Nouvelle branche » (audited).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const params = z.object({ projectId: z.uuid() });

export const GET = apiRoute({
  params,
  handler: ({ params: { projectId }, ctx }) => withProjectErrors(() => listProjectBranches(ctx, projectId)),
});

export const POST = apiRoute({
  params,
  body: createBranchInputSchema,
  rateLimit: { limit: 60, windowMs: 10 * 60_000 },
  handler: ({ params: { projectId }, body, ctx }) =>
    withProjectErrors(async () => Response.json(await createProjectBranch(ctx, projectId, body), { status: 201 })),
});
