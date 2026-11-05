import { pathsInputSchema, worktreeParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { unstagePaths, withWorkspaceErrors } from '@/server/workspace';

/** POST /api/worktrees/[worktreeId]/unstage { paths } — `git restore --staged` (« Retirer de l'index »). → { status } */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: worktreeParamsSchema,
  body: pathsInputSchema,
  rateLimit: { limit: 240, windowMs: 10 * 60_000 },
  handler: ({ params, body }) => withWorkspaceErrors(() => unstagePaths(params.worktreeId, body.paths)),
});
