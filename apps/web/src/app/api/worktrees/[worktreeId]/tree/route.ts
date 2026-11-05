import { treeQuerySchema, worktreeParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { getTree, withWorkspaceErrors } from '@/server/workspace';

/** GET /api/worktrees/[worktreeId]/tree?path= — one folder of the worktree (W1 `Arborescence`). → { path, entries, truncated } */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: worktreeParamsSchema,
  query: treeQuerySchema,
  handler: ({ params, query }) => withWorkspaceErrors(() => getTree(params.worktreeId, query.path)),
});
