import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { proxyRunnerStream } from '@/server/runner/client';
import { scopeOfSession } from '@/server/tenancy/scope';

/**
 * GET /api/stream/sessions/[id] — conversation stream of one Claude session: `session.status`,
 * `session.event` (normalised items, upserted by key/version) and `session.permission`.
 * First events = current snapshot; on reconnection the runner replays from Last-Event-ID (ids
 * namespaced by server) or sends `stream.reset` (reload the thread with the session events route,
 * Figma W7). The session must belong to the account's space (404 « Session introuvable. »
 * otherwise, before any runner call); relayed from the server of its project.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: z.object({ id: z.uuid() }),
  handler: async ({ request, params, ctx }) => {
    const scope = await scopeOfSession(ctx, params.id);
    return proxyRunnerStream(request, await scope.endpoint(), `/v1/sessions/${scope.sessionId}/stream`);
  },
});
