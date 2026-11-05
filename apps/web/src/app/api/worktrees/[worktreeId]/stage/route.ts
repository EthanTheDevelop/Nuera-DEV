import { pathsInputSchema, worktreeParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { stagePaths, withWorkspaceErrors } from '@/server/workspace';

/** POST /api/worktrees/[worktreeId]/stage { paths } — `git add -- <paths>` (« Indexer »). → { status } */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: worktreeParamsSchema,
  body: pathsInputSchema,
  rateLimit: { limit: 240, windowMs: 10 * 60_000 },
  handler: ({ params, body }) => withWorkspaceErrors(() => stagePaths(params.worktreeId, body.paths)),
});
