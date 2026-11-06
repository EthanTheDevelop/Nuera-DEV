import 'server-only';
import {
  encodeHeartbeat,
  encodeSseEvent,
  encodeStreamHello,
  HEARTBEAT_INTERVAL_MS,
  SSE_RETRY_MS,
  type RunnerEvent,
} from '@nuera/shared/events';
import { RunnerErrorBodySchema } from '@nuera/shared/runner';
import { hashToken } from '@nuera/shared/tokens';
import { promoteRunnerToken } from '@/server/admin/token-rotation';
import { AppError, toErrorResponse } from '@/server/errors';
import type { RunnerEndpoint } from './config';
import { RunnerError, runnerUnavailableMessage } from './errors';

/**
 * Relays a runner SSE stream to the browser (route handlers under /api/stream/*). The caller has
 * already checked that the resource belongs to the user's space (`scopeOf*()` of
 * `@/server/tenancy`) and passes the endpoint of the server holding it.
 *
 * - Event ids are namespaced by server: the runner's `id: 42` reaches the browser as
 *   `id: <environmentId>.42`. A `Last-Event-ID` (header set by EventSource on reconnect, or
 *   `?lastEventId=`) of the same server is forwarded as `42` so the runner replays missed events;
 *   any other value (another server, the former bare format, garbage) is NOT forwarded and the
 *   relay emits `stream.reset` first (the browser reloads the resource).
 * - Runner unreachable / connection lost → one `stream.error` event (`RUNNER_UNAVAILABLE`,
 *   « {nom} ne répond pas : le runner est injoignable. »), then the stream ends and EventSource
 *   reconnects by itself (`retry:`). Exception: the global stream with a web channel stays open
 *   (see {@link relayGlobalStream}).
 * - Runner 4xx (unknown session, terminal closed…) → plain JSON error with the same status, so
 *   EventSource stops retrying.
 * - The relay watches the runner: if nothing (not even a heartbeat) arrives for 2.5 heartbeat
 *   intervals, the stream is closed with `stream.error` so the browser reconnects.
 */

const NAMESPACED_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,20})$/i;

/** Interval between two attempts of the global relay to reach a runner that went away (T5 « toutes les 10 s »). */
export const RUNNER_PROBE_INTERVAL_MS = 10_000;

/**
 * Longest outage a global stream stays open through (5 min): after that the relay ends it and the
 * browser reconnects (T5, 10 s), so the web session and the account's context are checked again —
 * as the 10 s reconnections did before the stream outlived its runner.
 */
export const DEGRADED_STREAM_MAX_MS = 5 * 60_000;

/** `<environmentId>.<seq>` — the id the browser sees for event `seq` of a server. */
export function namespaceEventId(environmentId: string, seq: string | number): string {
  return `${environmentId}.${seq}`;
}

/**
 * What to do with the `Last-Event-ID` a browser sent: `upstream` is forwarded to the runner of
 * `environmentId`; `reset` asks for a `stream.reset` (the id belongs to another server or format).
 */
export function resolveLastEventId(raw: string | null | undefined, environmentId: string): { upstream: string | null; reset: boolean } {
  const value = raw?.trim();
  if (!value) return { upstream: null, reset: false };
  const match = NAMESPACED_ID.exec(value);
  if (match && match[1]!.toLowerCase() === environmentId.toLowerCase()) return { upstream: match[2]!, reset: false };
  return { upstream: null, reset: true };
}

function requestedLastEventId(req: Request): string | null {
  return req.headers.get('last-event-id') ?? new URL(req.url).searchParams.get('lastEventId');
}

/** Rewrites the `id:` lines of complete SSE frames (`…\n\n`) with the server prefix. */
function namespaceFrame(frame: string, environmentId: string): string {
  if (!frame.includes('id:')) return frame;
  return frame
    .split('\n')
    .map((line) => {
      if (!line.startsWith('id:')) return line;
      const value = line.slice(3).replace(/\r$/, '').trim();
      return value ? `id: ${namespaceEventId(environmentId, value)}` : line;
    })
    .join('\n');
}

/** The runner's own id of a frame (`id: 42`), or null (heartbeat, no id, anything else). */
function upstreamFrameId(frame: string): string | null {
  if (!frame.includes('id:')) return null;
  for (const line of frame.split('\n')) {
    if (!line.startsWith('id:')) continue;
    const value = line.slice(3).replace(/\r$/, '').trim();
    return /^\d{1,20}$/.test(value) ? value : null;
  }
  return null;
}

function sseHeaders(): Headers {
  return new Headers({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

function webEvent(event: Omit<RunnerEvent, 'seq' | 'at'> & { at?: string }): string {
  return encodeSseEvent({ seq: 0, at: new Date().toISOString(), ...event } as RunnerEvent, { withId: false });
}

function errorEvent(code: string, message: string): string {
  return webEvent({ type: 'stream.error', data: { code, message } } as RunnerEvent);
}

function resetEvent(): string {
  return webEvent({ type: 'stream.reset', data: { reason: 'replay_unavailable' } } as RunnerEvent);
}

/**
 * Web-only events of the global stream about its runner (not part of the runner contract, parsed by
 * `hooks/useLiveEvents.tsx`): `runner.unavailable` { retryInMs } — the relay could not reach the
 * runner and tries again in `retryInMs` (follows `stream.error` RUNNER_UNAVAILABLE, then again after
 * each failed attempt); `runner.available` — the relay reached it again, the runner's frames follow.
 */
function runnerAvailabilityEvent(available: boolean, retryInMs: number): string {
  const frame = available
    ? { seq: 0, type: 'runner.available', at: new Date().toISOString(), data: {} }
    : { seq: 0, type: 'runner.unavailable', at: new Date().toISOString(), data: { retryInMs } };
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/** A short SSE response: `prelude`, one `stream.error`, a heartbeat (EventSource retries after `retry:`). */
function errorStream(prelude: readonly string[], code: string, message: string): Response {
  const body = `retry: ${SSE_RETRY_MS * 2}\n\n${prelude.join('')}${errorEvent(code, message)}${encodeHeartbeat()}`;
  return new Response(body, { status: 200, headers: sseHeaders() });
}

/**
 * T5 answer of a relay whose scope check could not reach the runner (terminals are checked on the
 * runner itself): one `stream.error` RUNNER_UNAVAILABLE « {nom} ne répond pas : le runner est
 * injoignable. », then EventSource / the terminal connection retries, exactly as when the relay
 * itself cannot connect.
 */
export function runnerUnavailableStream(environmentName: string): Response {
  return errorStream([], 'RUNNER_UNAVAILABLE', runnerUnavailableMessage(environmentName));
}

/** Event of the web's own per-user channel (`notification.created`, `notification.read`…). */
export interface WebChannelEvent {
  type: string;
  at?: string;
  data: unknown;
}

/**
 * Per-user web channel merged into the global stream (notifications, account events): called with
 * a `push` callback, returns its unsubscribe function. Events are sent as `{ seq: 0, type, at,
 * data }` without `id:` (never replayed, never moving Last-Event-ID). Lot W5 plugs it in:
 *
 *   relayGlobalStream(request, { userId, endpoint, webChannel: (push) => subscribeUserEvents(userId, push) });
 */
export type WebChannel = (push: (event: WebChannelEvent) => void) => () => void;

function encodeWebChannelEvent(event: WebChannelEvent): string {
  return `data: ${JSON.stringify({ seq: 0, type: event.type, at: event.at ?? new Date().toISOString(), data: event.data })}

`;
}

interface RelayOptions {
  /** Frames written first, before anything from the runner (`stream.hello`). */
  prelude?: readonly string[];
  webChannel?: WebChannel;
}

type Source = { reader: ReadableStreamDefaultReader<Uint8Array>; abort: () => void; environmentId: string; name: string };

/** `unavailable`: the runner cannot be reached (message for `stream.error`); `response`: its 4xx answer, as JSON. */
type Upstream =
  | { ok: true; reader: ReadableStreamDefaultReader<Uint8Array>; abort: () => void }
  | { ok: false; unavailable: string }
  | { ok: false; response: Response };

async function openUpstream(req: Request, endpoint: RunnerEndpoint, runnerPath: string, lastEventId: string | null): Promise<Upstream> {
  if (!endpoint.baseUrl || !endpoint.token) {
    return { ok: false, unavailable: endpoint.problem ?? runnerUnavailableMessage(endpoint.name) };
  }
  const upstreamAbort = new AbortController();
  const onClientAbort = () => upstreamAbort.abort();
  req.signal.addEventListener('abort', onClientAbort, { once: true });

  const connect = async (token: string): Promise<Response> => {
    // The timeout covers the connection only: the stream itself stays open as long as needed.
    const connectTimer = setTimeout(() => upstreamAbort.abort(), 15_000);
    try {
      return await fetch(`${endpoint.baseUrl}${runnerPath}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream',
          ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
        },
        signal: upstreamAbort.signal,
        cache: 'no-store',
      });
    } finally {
      clearTimeout(connectTimer);
    }
  };

  let upstream: Response;
  try {
    upstream = await connect(endpoint.token);
    if (upstream.status === 401 && endpoint.fallbackToken) {
      await upstream.body?.cancel().catch(() => undefined);
      upstream = await connect(endpoint.fallbackToken);
      // The runner accepted the rotated token: promote it (see callRunner).
      if (upstream.ok) void promoteRunnerToken(endpoint.environmentId, hashToken(endpoint.fallbackToken));
    }
  } catch {
    req.signal.removeEventListener('abort', onClientAbort);
    return { ok: false, unavailable: runnerUnavailableMessage(endpoint.name) };
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
      return { ok: false, unavailable: runnerUnavailableMessage(endpoint.name) };
    }
    const message = parsed?.success ? parsed.data.error.message : 'Flux indisponible.';
    const code = upstream.status === 404 ? 'NOT_FOUND' : upstream.status === 409 ? 'CONFLICT' : 'VALIDATION';
    return {
      ok: false,
      response: toErrorResponse(new RunnerError(code, message, { status: upstream.status, environmentId: endpoint.environmentId })),
    };
  }
  return {
    ok: true,
    reader: upstream.body.getReader(),
    abort: () => {
      req.signal.removeEventListener('abort', onClientAbort);
      upstreamAbort.abort();
    },
  };
}

/**
 * Reads `source` and hands over its complete SSE frames (`…\n\n`, ids not yet namespaced); `onActivity`
 * on every chunk (heartbeats included). Resolves when the upstream ends: `done` (closed by the
 * runner) or `error` (connection lost, or aborted by the relay).
 */
async function pumpFrames(source: Source, onFrame: (frame: string) => void, onActivity: () => void): Promise<'done' | 'error'> {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await source.reader.read();
      if (done) break;
      onActivity();
      if (!value || value.byteLength === 0) continue;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        onFrame(buffer.slice(0, boundary + 2));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) onFrame(`${buffer}\n\n`);
    return 'done';
  } catch {
    return 'error';
  }
}

function stopSource(source: Source): void {
  source.abort();
  source.reader.cancel().catch(() => undefined);
}

/**
 * The SSE response itself: prelude, then the runner's frames (ids namespaced) and the web channel's
 * events, interleaved only at frame boundaries. Without upstream (no server), web heartbeats keep
 * the connection alive until the browser leaves.
 */
function relayResponse(req: Request, source: Source | null, options: RelayOptions): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let lastUpstreamActivity = Date.now();

  const cleanup = () => {
    if (watchdog) clearInterval(watchdog);
    if (keepAlive) clearInterval(keepAlive);
    try {
      unsubscribe?.();
    } catch {
      // the channel is gone already
    }
    unsubscribe = undefined;
    if (source) stopSource(source);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (closed || !text) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // already closed
        }
      };
      const close = (withError?: string) => {
        if (closed) return;
        if (withError) write(errorEvent('RUNNER_UNAVAILABLE', withError));
        closed = true;
        req.signal.removeEventListener('abort', onAbort);
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const onAbort = () => close();
      req.signal.addEventListener('abort', onAbort, { once: true });

      if (!source) write(`retry: ${SSE_RETRY_MS}\n\n`);
      for (const frame of options.prelude ?? []) write(frame);

      if (options.webChannel) {
        try {
          unsubscribe = options.webChannel((event) => write(encodeWebChannelEvent(event)));
        } catch (error) {
          console.error('[stream] canal web indisponible', error instanceof Error ? error.message : error);
        }
      }

      if (!source) {
        keepAlive = setInterval(() => write(encodeHeartbeat()), HEARTBEAT_INTERVAL_MS);
        return;
      }

      watchdog = setInterval(() => {
        if (Date.now() - lastUpstreamActivity > HEARTBEAT_INTERVAL_MS * 2.5) close('Connexion au runner perdue.');
      }, HEARTBEAT_INTERVAL_MS);

      void pumpFrames(
        source,
        (frame) => write(namespaceFrame(frame, source.environmentId)),
        () => {
          lastUpstreamActivity = Date.now();
        },
      ).then((end) => (end === 'done' ? close() : close(req.signal.aborted ? undefined : 'Connexion au runner perdue.')));
    },
    cancel() {
      closed = true;
      cleanup();
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
}

interface DegradableRelayInput {
  prelude: readonly string[];
  webChannel: WebChannel;
  endpoint: RunnerEndpoint;
  /** Re-reads the server's endpoint before each new attempt (rotated token, changed URL). */
  resolveEndpoint?: () => Promise<RunnerEndpoint>;
  /** Runner id to resume after (forwarded as Last-Event-ID), from the browser then from the frames relayed. */
  lastEventId: string | null;
  /** First connection: open, or the reason it failed. */
  initial: { ok: true; reader: ReadableStreamDefaultReader<Uint8Array>; abort: () => void } | { ok: false; unavailable: string };
  probeIntervalMs: number;
  /** Longest outage before the relay ends the stream (the browser reconnects: session re-checked). */
  maxDegradedMs: number;
}

/**
 * Global stream with a web channel (GAP C2a): the browser connection outlives its runner. When the
 * runner cannot be reached (at open, connection lost, silent for 2.5 heartbeats), the relay writes
 * `stream.error` RUNNER_UNAVAILABLE then `runner.unavailable` { retryInMs }, keeps the stream open
 * with its own heartbeats and the web channel (notifications keep arriving), and tries the runner
 * again every `probeIntervalMs` (`runner.unavailable` again after each failure). Once it answers:
 * `runner.available`, then the runner's frames, resumed after the last relayed id (the runner replays
 * or sends `stream.reset`). A runner that closes its stream itself (restart) is retried after
 * `SSE_RETRY_MS` before anything is announced. The server deleted, retired, suspended (its account
 * disabled) or replaced, or an outage longer than `maxDegradedMs` → the stream ends (the browser
 * reconnects: its web session and its context are checked again).
 */
function degradableGlobalResponse(req: Request, input: DegradableRelayInput): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let source: Source | null = null;
  let endpoint = input.endpoint;
  let lastEventId = input.lastEventId;
  let lastUpstreamActivity = Date.now();
  /** The browser was told the runner is unavailable (and not yet that it is back). */
  let announced = false;
  /** Start of the current outage (ms epoch), null while the runner is attached. */
  let degradedSince: number | null = null;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;

  const detach = () => {
    if (watchdog) clearInterval(watchdog);
    watchdog = undefined;
    const current = source;
    source = null;
    if (current) stopSource(current);
  };

  const cleanup = () => {
    detach();
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = undefined;
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = undefined;
    try {
      unsubscribe?.();
    } catch {
      // the channel is gone already
    }
    unsubscribe = undefined;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (closed || !text) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // already closed
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        req.signal.removeEventListener('abort', close);
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener('abort', close, { once: true });

      /** The runner is out of reach: tell the browser (T5), keep the web channel alive, try again later. */
      const degrade = (message: string) => {
        if (closed) return;
        degradedSince ??= Date.now();
        // A long outage: end the stream so that the browser reconnects through the authentication
        // again (a revoked access or a disabled account stops receiving anything).
        if (Date.now() - degradedSince >= input.maxDegradedMs) {
          close();
          return;
        }
        if (!announced) {
          announced = true;
          write(errorEvent('RUNNER_UNAVAILABLE', message));
        }
        write(runnerAvailabilityEvent(false, input.probeIntervalMs));
        keepAlive ??= setInterval(() => write(encodeHeartbeat()), HEARTBEAT_INTERVAL_MS);
        if (probeTimer) clearTimeout(probeTimer);
        probeTimer = setTimeout(() => void probe(), input.probeIntervalMs);
      };

      const attach = (opened: { reader: ReadableStreamDefaultReader<Uint8Array>; abort: () => void }) => {
        const current: Source = { ...opened, environmentId: endpoint.environmentId, name: endpoint.name };
        if (keepAlive) clearInterval(keepAlive);
        keepAlive = undefined;
        degradedSince = null;
        if (announced) {
          announced = false;
          write(runnerAvailabilityEvent(true, input.probeIntervalMs));
        }
        source = current;
        lastUpstreamActivity = Date.now();
        watchdog = setInterval(() => {
          if (source !== current || Date.now() - lastUpstreamActivity <= HEARTBEAT_INTERVAL_MS * 2.5) return;
          detach();
          degrade('Connexion au runner perdue.');
        }, HEARTBEAT_INTERVAL_MS);
        void pumpFrames(
          current,
          (frame) => {
            if (source !== current) return;
            const id = upstreamFrameId(frame);
            if (id) lastEventId = id;
            write(namespaceFrame(frame, current.environmentId));
          },
          () => {
            if (source === current) lastUpstreamActivity = Date.now();
          },
        ).then((end) => {
          if (closed || source !== current) return;
          detach();
          // Closed by the runner itself (restart): a quick attempt before declaring T5 (never a tight
          // loop on a runner that keeps closing at once).
          if (end === 'done') probeTimer = setTimeout(() => void probe(), Math.min(SSE_RETRY_MS, input.probeIntervalMs));
          else degrade('Connexion au runner perdue.');
        });
      };

      const probe = async () => {
        probeTimer = undefined;
        if (closed || source) return;
        if (input.resolveEndpoint) {
          try {
            const next = await input.resolveEndpoint();
            if (closed) return;
            // Another server now, this one retired, or suspended (its account disabled): this stream no
            // longer describes the account's context — the browser reconnects through the authentication.
            if (next.environmentId !== endpoint.environmentId || next.status === 'retired' || next.status === 'suspended') {
              close();
              return;
            }
            endpoint = next;
          } catch (error) {
            if (closed) return;
            if (error instanceof AppError && error.code === 'NOT_FOUND') {
              close();
              return;
            }
            // Database unavailable for a moment: try with the endpoint known.
          }
        }
        const opened = await openUpstream(req, endpoint, '/v1/events', lastEventId);
        if (closed) {
          if (opened.ok) {
            opened.abort();
            opened.reader.cancel().catch(() => undefined);
          }
          return;
        }
        if (opened.ok) attach(opened);
        else degrade('unavailable' in opened ? opened.unavailable : runnerUnavailableMessage(endpoint.name));
      };

      for (const frame of input.prelude) write(frame);
      try {
        unsubscribe = input.webChannel((event) => write(encodeWebChannelEvent(event)));
      } catch (error) {
        console.error('[stream] canal web indisponible', error instanceof Error ? error.message : error);
      }
      if (input.initial.ok) attach(input.initial);
      else degrade(input.initial.unavailable);
    },
    cancel() {
      closed = true;
      cleanup();
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
}

/**
 * Relays `runnerPath` (`/v1/sessions/<id>/stream`…) of the server of `endpoint`. The caller has
 * checked the scope first; `prelude` frames are written before the runner's.
 */
export async function proxyRunnerStream(req: Request, endpoint: RunnerEndpoint, runnerPath: string, options: RelayOptions = {}): Promise<Response> {
  if (!runnerPath.startsWith('/v1/')) throw new Error('Chemin de flux runner invalide.');
  const { upstream: lastEventId, reset } = resolveLastEventId(requestedLastEventId(req), endpoint.environmentId);
  const prelude = [...(options.prelude ?? []), ...(reset ? [resetEvent()] : [])];
  const opened = await openUpstream(req, endpoint, runnerPath, lastEventId);
  if (!opened.ok) return 'unavailable' in opened ? errorStream(prelude, 'RUNNER_UNAVAILABLE', opened.unavailable) : opened.response;
  return relayResponse(req, { reader: opened.reader, abort: opened.abort, environmentId: endpoint.environmentId, name: endpoint.name }, { ...options, prelude });
}

/**
 * Global stream of one account (`/api/stream/events`): `stream.hello` { userId, environmentId }
 * first, then the server's events (`/v1/events`, ids namespaced) merged with the per-user web
 * channel. An account without a server still gets hello, the web channel and heartbeats. With a
 * web channel, a runner out of reach no longer ends the stream: see {@link degradableGlobalResponse}
 * (`resolveEndpoint` re-reads the server before each new attempt).
 */
export async function relayGlobalStream(
  req: Request,
  input: {
    userId: string;
    endpoint: RunnerEndpoint | null;
    webChannel?: WebChannel;
    resolveEndpoint?: () => Promise<RunnerEndpoint>;
    /** Tests only: interval between two attempts while the runner is out of reach. */
    probeIntervalMs?: number;
    /** Tests only: longest outage before the stream ends ({@link DEGRADED_STREAM_MAX_MS}). */
    maxDegradedMs?: number;
  },
): Promise<Response> {
  const hello = encodeStreamHello({ userId: input.userId, environmentId: input.endpoint?.environmentId ?? null });
  if (!input.endpoint) return relayResponse(req, null, { prelude: [hello], webChannel: input.webChannel });
  if (!input.webChannel) return proxyRunnerStream(req, input.endpoint, '/v1/events', { prelude: [hello] });

  const endpoint = input.endpoint;
  const { upstream: lastEventId, reset } = resolveLastEventId(requestedLastEventId(req), endpoint.environmentId);
  const prelude = [hello, ...(reset ? [resetEvent()] : [])];
  const opened = await openUpstream(req, endpoint, '/v1/events', lastEventId);
  // A runner 4xx (refused path…) is not an outage: answered as JSON, exactly as before.
  if (!opened.ok && 'response' in opened) return opened.response;
  return degradableGlobalResponse(req, {
    prelude,
    webChannel: input.webChannel,
    endpoint,
    resolveEndpoint: input.resolveEndpoint,
    lastEventId,
    initial: opened,
    probeIntervalMs: Math.max(10, input.probeIntervalMs ?? RUNNER_PROBE_INTERVAL_MS),
    maxDegradedMs: Math.max(0, input.maxDegradedMs ?? DEGRADED_STREAM_MAX_MS),
  });
}
