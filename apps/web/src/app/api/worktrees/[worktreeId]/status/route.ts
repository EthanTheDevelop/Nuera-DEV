import { worktreeParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { getWorktreeStatus, withWorkspaceErrors } from '@/server/workspace';

/** GET /api/worktrees/[worktreeId]/status — `git status` + ahead / behind vs the base (`Actions Git`, S3). → { status, branch } */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: worktreeParamsSchema,
  handler: ({ params }) => withWorkspaceErrors(() => getWorktreeStatus(params.worktreeId)),
});
