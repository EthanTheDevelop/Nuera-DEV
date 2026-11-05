import { worktreeParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { getChanges, withWorkspaceErrors } from '@/server/workspace';

/** GET /api/worktrees/[worktreeId]/changes — uncommitted changes vs HEAD (D05 `Modifications`, W5 files). → ChangesResponse */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: worktreeParamsSchema,
  handler: ({ params }) => withWorkspaceErrors(() => getChanges(params.worktreeId)),
});
