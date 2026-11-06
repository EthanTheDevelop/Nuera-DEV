import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { getRunDetail, stopRun, withProjectErrors } from '@/server/projects';

/**
 * GET /api/runs/[runId] — { run, live, outputTail, tests, projectId } (state from the runner of the
 * project's server when it answers, stored row otherwise). DELETE — stops the process (idempotent
 * once finished; audited). A run of another space answers « Lancement introuvable. » (404).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const params = z.object({ runId: z.uuid() });

export const GET = apiRoute({
  params,
  handler: ({ params: { runId }, ctx }) => withProjectErrors(() => getRunDetail(ctx, runId)),
});

export const DELETE = apiRoute({
  params,
  handler: ({ params: { runId }, ctx }) =>
    withProjectErrors(async () => {
      await stopRun(ctx, runId);
      return undefined;
    }),
});
