import { apiRoute } from '@/server/http';
import { listRuns, listRunsQuerySchema, startRun, startRunInputSchema, withProjectErrors } from '@/server/projects';

/**
 * POST /api/runs — { projectId, worktreeId?, kind: install|dev|build|test|lint|custom, command? }
 * → 201 { runId, run }: starts a project command in a worktree (default: the primary clone) with
 * the project's variables. Live output: /api/stream/runs/<runId> (`run.status`, `run.output`).
 * GET /api/runs?projectId=&worktreeId=&limit= — recent runs (Workspace « Tests », project tabs).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  body: startRunInputSchema,
  maxBodyBytes: 16 * 1024,
  rateLimit: { limit: 60, windowMs: 10 * 60_000 },
  handler: ({ body, user }) =>
    withProjectErrors(async () => Response.json(await startRun(body, user), { status: 201, headers: { 'cache-control': 'no-store' } })),
});

export const GET = apiRoute({
  query: listRunsQuerySchema,
  handler: ({ query }) => withProjectErrors(async () => ({ runs: await listRuns(query) })),
});
