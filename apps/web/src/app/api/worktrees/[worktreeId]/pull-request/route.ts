import { pullRequestInputSchema, worktreeParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { openPullRequest, withWorkspaceErrors } from '@/server/workspace';

/**
 * POST /api/worktrees/[worktreeId]/pull-request { title, body?, base?, draft?, sessionId? } — W5 step 3:
 * pull request from the worktree branch (GitHub API), stored in `pull_requests`. Audited
 * `github.pull_request`. → { number, title, url, state, draft, baseBranch, headBranch }
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: worktreeParamsSchema,
  body: pullRequestInputSchema,
  maxBodyBytes: 128 * 1024,
  rateLimit: { limit: 30, windowMs: 10 * 60_000 },
  handler: ({ params, body, user }) =>
    withWorkspaceErrors(async () => Response.json(await openPullRequest(params.worktreeId, body, user), { status: 201 })),
});
