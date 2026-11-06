import { pushInputSchema, worktreeParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { pushBranch, withWorkspaceErrors } from '@/server/workspace';

/**
 * POST /api/worktrees/[worktreeId]/push { sessionId? } — W5 step 2: push of the worktree branch with
 * a GitHub token limited to this repository (contents:write). The default branch is refused
 * (`BRANCH_PROTECTED`). Audited `git.push`. → { branch, remoteBranch, headSha, upToDate, createdRemoteBranch, url }
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: worktreeParamsSchema,
  body: pushInputSchema,
  maxBodyBytes: 4 * 1024,
  rateLimit: { limit: 30, windowMs: 10 * 60_000 },
  handler: ({ params, body, ctx }) => withWorkspaceErrors(() => pushBranch(ctx, params.worktreeId, body)),
});
