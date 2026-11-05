import { diffQuerySchema, worktreeParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { getDiff, withWorkspaceErrors } from '@/server/workspace';

/** GET /api/worktrees/[worktreeId]/diff?path=&against=head|staged — hunks of one file (D05, W4, S2). → FileDiff */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: worktreeParamsSchema,
  query: diffQuerySchema,
  rateLimit: { limit: 600, windowMs: 10 * 60_000 },
  handler: ({ params, query }) => withWorkspaceErrors(() => getDiff(params.worktreeId, query.path, query.against)),
});
