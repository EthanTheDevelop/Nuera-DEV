import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { proxyRunnerStream } from '@/server/runner/client';
import { scopeOfOperation } from '@/server/tenancy/scope';

/**
 * GET /api/stream/operations/[id] — long operation (clone A2, pull, push…): `operation.progress`
 * events. The first one carries the whole journal (`log`), the next ones `logAppend` (final lines)
 * and `liveLine` (git progress / spinner line updated in place). The operation must belong to the
 * account's space (404 « Opération introuvable. » otherwise, before any runner call); relayed from
 * the server running it.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: z.object({ id: z.uuid() }),
  handler: async ({ request, params, ctx }) => {
    const scope = await scopeOfOperation(ctx, params.id);
    return proxyRunnerStream(request, await scope.endpoint(), `/v1/operations/${scope.operationId}/stream`);
  },
});
