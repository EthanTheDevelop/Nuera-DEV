import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { proxyRunnerStream } from '@/server/runner/client';

/**
 * GET /api/stream/operations/[id] — long operation (clone A2, pull, push…): `operation.progress`
 * events. The first one carries the whole journal (`log`), the next ones `logAppend` (final lines)
 * and `liveLine` (git progress / spinner line updated in place).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: z.object({ id: z.uuid() }),
  handler: ({ request, params }) => proxyRunnerStream(request, `/v1/operations/${params.id}/stream`),
});
