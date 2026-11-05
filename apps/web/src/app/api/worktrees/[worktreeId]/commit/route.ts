import { commitInputSchema, worktreeParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { commitChanges, withWorkspaceErrors } from '@/server/workspace';

/**
 * POST /api/worktrees/[worktreeId]/commit { message, body?, paths, sessionId? } — W5 step 1, with the
 * owner as author (repository hooks off). Audited `git.commit`. → { sha, shortSha, branch, filesCommitted, insertions, deletions }
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: worktreeParamsSchema,
  body: commitInputSchema,
  maxBodyBytes: 256 * 1024,
  rateLimit: { limit: 60, windowMs: 10 * 60_000 },
  handler: ({ params, body, user }) => withWorkspaceErrors(() => commitChanges(params.worktreeId, body, user)),
});
