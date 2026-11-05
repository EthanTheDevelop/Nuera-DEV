import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { proxyRunnerStream } from '@/server/runner/client';

/**
 * GET /api/stream/sessions/[id] — conversation stream of one Claude session: `session.status`,
 * `session.event` (normalised items, upserted by key/version) and `session.permission`.
 * First events = current snapshot; on reconnection the runner replays from Last-Event-ID or sends
 * `stream.reset` (reload the thread with the session events route, Figma W7).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: z.object({ id: z.uuid() }),
  handler: ({ request, params }) => proxyRunnerStream(request, `/v1/sessions/${params.id}/stream`),
});
