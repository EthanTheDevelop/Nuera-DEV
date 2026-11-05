import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { proxyRunnerStream } from '@/server/runner/client';

/**
 * GET /api/stream/runs/[id] — a project command (install/dev/build/test…): `run.status` (status,
 * port, parsed test results) and `run.output` (raw output; the first one has `replay: true` and
 * holds the buffered tail).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: z.object({ id: z.uuid() }),
  handler: ({ request, params }) => proxyRunnerStream(request, `/v1/runs/${params.id}/stream`),
});
