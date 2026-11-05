import 'server-only';
import { encodeHeartbeat, encodeSseEvent, HEARTBEAT_INTERVAL_MS, SSE_RETRY_MS } from '@nuera/shared/events';
import { RunnerErrorBodySchema } from '@nuera/shared/runner';
import { toErrorResponse } from '@/server/errors';
import { getRunnerConfig } from './config';
import { RunnerError } from './errors';

/**
 * Relays a runner SSE stream to the browser (route handlers under /api/stream/*). The caller has
 * already authenticated the user.
 *
 * - `Last-Event-ID` (header set by EventSource on reconnect, or `?lastEventId=`) is forwarded so
 *   the runner replays missed events (or answers `stream.reset`).
 * - Runner unreachable / connection lost → one `stream.error` event (`RUNNER_UNAVAILABLE`), then
 *   the stream ends and EventSource reconnects by itself (`retry:`).
 * - Runner 4xx (unknown session, terminal closed…) → plain JSON error with the same status, so
 *   EventSource stops retrying.
 * - The relay watches the runner: if nothing (not even a heartbeat) arrives for 2.5 heartbeat
 *   intervals, the stream is closed with `stream.error` so the browser reconnects.
 */
export async function proxyRunnerStream(req: Request, runnerPath: string): Promise<Response> {
  const { baseUrl, token } = getRunnerConfig();
  const lastEventId =
    req.headers.get('last-event-id') ?? new URL(req.url).searchParams.get('lastEventId') ?? undefined;

  if (!token) return errorStream('RUNNER_UNAVAILABLE', "RUNNER_TOKEN n'est pas configuré côté web.");
  if (!runnerPath.startsWith('/v1/')) throw new Error('Chemin de flux runner invalide.');

  const upstreamAbort = new AbortController();
  const onClientAbort = () => upstreamAbort.abort();
  req.signal.addEventListener('abort', onClientAbort, { once: true });

  let upstream: Response;
  // The timeout covers the connection only: the stream itself stays open as long as needed.
  const connectTimer = setTimeout(() => upstreamAbort.abort(), 15_000);
  try {
    upstream = await fetch(`${baseUrl}${runnerPath}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        ...(lastEventId && /^\d{1,20}$/.test(lastEventId) ? { 'last-event-id': lastEventId } : {}),
      },
      signal: upstreamAbort.signal,
      cache: 'no-store',
    });
  } catch {
    req.signal.removeEventListener('abort', onClientAbort);
    return errorStream('RUNNER_UNAVAILABLE', 'VPS-3 ne répond pas : le runner est injoignable.');
  } finally {
    clearTimeout(connectTimer);
  }

  if (!upstream.ok || !upstream.body) {
    req.signal.removeEventListener('abort', onClientAbort);
    const text = await upstream.text().catch(() => '');
    let parsed: ReturnType<typeof RunnerErrorBodySchema.safeParse> | null = null;
    try {
      parsed = RunnerErrorBodySchema.safeParse(JSON.parse(text));
    } catch {
      parsed = null;
    }
    if (upstream.status >= 500 || upstream.status === 401) {
      return errorStream('RUNNER_UNAVAILABLE', 'VPS-3 ne répond pas : le runner est injoignable.');
    }
    const message = parsed?.success ? parsed.data.error.message : 'Flux indisponible.';
    const code = upstream.status === 404 ? 'NOT_FOUND' : upstream.status === 409 ? 'CONFLICT' : 'VALIDATION';
    return toErrorResponse(new RunnerError(code, message, { status: upstream.status }));
  }

  const reader = upstream.body.getReader();
  const encoder = new TextEncoder();
  let lastUpstreamActivity = Date.now();
  let closed = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (withError?: string) => {
        if (closed) return;
        closed = true;
        if (watchdog) clearInterval(watchdog);
        req.signal.removeEventListener('abort', onAbort);
        if (withError) {
          try {
            controller.enqueue(encoder.encode(errorEvent('RUNNER_UNAVAILABLE', withError)));
          } catch {
            // already closed
          }
        }
        upstreamAbort.abort();
        reader.cancel().catch(() => undefined);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const onAbort = () => close();
      req.signal.addEventListener('abort', onAbort, { once: true });

      watchdog = setInterval(() => {
        if (Date.now() - lastUpstreamActivity > HEARTBEAT_INTERVAL_MS * 2.5) {
          close('Connexion au runner perdue.');
        }
      }, HEARTBEAT_INTERVAL_MS);

      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            lastUpstreamActivity = Date.now();
            if (value && value.byteLength > 0) controller.enqueue(value);
          }
          close();
        } catch {
          close(req.signal.aborted ? undefined : 'Connexion au runner perdue.');
        }
      })();
    },
    cancel() {
      closed = true;
      if (watchdog) clearInterval(watchdog);
      upstreamAbort.abort();
      reader.cancel().catch(() => undefined);
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
}

function sseHeaders(): Headers {
  return new Headers({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

function errorEvent(code: string, message: string): string {
  return encodeSseEvent(
    { seq: 0, type: 'stream.error', at: new Date().toISOString(), data: { code, message } },
    { withId: false },
  );
}

/** A short SSE response carrying one `stream.error` (EventSource then retries after `retry:`). */
function errorStream(code: string, message: string): Response {
  const body = `retry: ${SSE_RETRY_MS * 2}\n\n${errorEvent(code, message)}${encodeHeartbeat()}`;
  return new Response(body, { status: 200, headers: sseHeaders() });
}
