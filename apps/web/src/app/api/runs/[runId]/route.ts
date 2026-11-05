import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { getRunDetail, stopRun, withProjectErrors } from '@/server/projects';

/**
 * GET /api/runs/[runId] — { run, live, outputTail, tests, projectId } (runner state when it
 * answers, stored row otherwise). DELETE — stops the process (idempotent once finished; audited).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const params = z.object({ runId: z.uuid() });

export const GET = apiRoute({
  params,
  handler: ({ params: { runId } }) => withProjectErrors(() => getRunDetail(runId)),
});

export const DELETE = apiRoute({
  params,
  handler: ({ params: { runId }, user }) =>
    withProjectErrors(async () => {
      await stopRun(runId, user);
      return undefined;
    }),
});
