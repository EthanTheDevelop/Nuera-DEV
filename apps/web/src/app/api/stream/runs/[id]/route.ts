import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { proxyRunnerStream } from '@/server/runner/client';
import { scopeOfRun } from '@/server/tenancy/scope';

/**
 * GET /api/stream/runs/[id] — a project command (install/dev/build/test…): `run.status` (status,
 * port, parsed test results) and `run.output` (raw output; the first one has `replay: true` and
 * holds the buffered tail). The run must belong to the account's space (404 « Lancement
 * introuvable. » otherwise, before any runner call); relayed from the server of its project.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: z.object({ id: z.uuid() }),
  handler: async ({ request, params, ctx }) => {
    const scope = await scopeOfRun(ctx, params.id);
    return proxyRunnerStream(request, await scope.endpoint(), `/v1/runs/${scope.runId}/stream`);
  },
});
