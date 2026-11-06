import { apiRoute } from '@/server/http';
import { subscribeUserEvents } from '@/server/notifications/user-events';
import { getRunnerEndpoint, relayGlobalStream } from '@/server/runner/client';

/**
 * GET /api/stream/events — global SSE stream of the account: `stream.hello` { userId,
 * environmentId } first (multi-tab identity guard), then the events of the server of its space
 * (session statuses, permission requests, operations, runs, system metrics every 5 s, Claude CLI
 * status), relayed with Last-Event-ID replay and ids namespaced by server
 * (`<environmentId>.<seq>`), merged with the account's own web channel (`notification.created`,
 * `notification.read`: seq 0, no `id:` line, never replayed). An account without a server still
 * gets hello, its web channel and heartbeats. When the runner is out of reach the stream stays open
 * for the web channel: `stream.error` RUNNER_UNAVAILABLE, then `runner.unavailable` { retryInMs }
 * after each attempt of the relay (every 10 s) and `runner.available` once it answers again (its
 * events follow, resumed after the last id). Parse each message with `parseRunnerEvent` from
 * `@nuera/shared/events` (`notification.read` and `runner.*` are web events: see
 * `hooks/useLiveEvents.tsx`).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  handler: async ({ request, ctx }) => {
    const userId = ctx.user.id;
    const environmentId = ctx.environment?.id ?? null;
    return relayGlobalStream(request, {
      userId,
      endpoint: environmentId ? await getRunnerEndpoint(environmentId) : null,
      // Each new attempt while the runner is out of reach re-reads its endpoint (rotated token, new URL).
      ...(environmentId ? { resolveEndpoint: () => getRunnerEndpoint(environmentId) } : {}),
      // Only this account's events: the bus delivers to the listeners of `userId` alone.
      webChannel: (push) => subscribeUserEvents(userId, (event) => push(event)),
    });
  },
});
