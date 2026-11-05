import { apiRoute } from '@/server/http';
import { proxyRunnerStream } from '@/server/runner/client';

/**
 * GET /api/stream/events — global SSE stream (session statuses, permission requests, operations,
 * runs, system metrics every 5 s, Claude CLI status, notifications). Relayed from the runner with
 * Last-Event-ID replay. Parse each message with `parseRunnerEvent` from `@nuera/shared/events`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  handler: ({ request }) => proxyRunnerStream(request, '/v1/events'),
});
