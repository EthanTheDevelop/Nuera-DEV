import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  encodeHeartbeat,
  encodeSseEvent,
  HEARTBEAT_INTERVAL_MS,
  SSE_RETRY_MS,
  type RunnerEvent,
  type RunnerEventData,
  type RunnerEventType,
} from '@nuera/shared/events';
import type { Channel, EventBus } from '../events/bus';

const MAX_PENDING_BYTES = 16 * 1024 * 1024;

export interface SseStreamOptions {
  request: FastifyRequest;
  reply: FastifyReply;
  bus: EventBus;
  channel: Channel;
  /** Honour `Last-Event-ID` (ring-buffer replay, or `stream.reset` when impossible). */
  replayable: boolean;
  /**
   * Snapshot events sent after the replay (or first, without Last-Event-ID). They are not
   * replayable themselves (no `id:`), only the live events carry ids.
   */
  initial?: (context: { replayed: boolean }) => Promise<SnapshotEvent[]> | SnapshotEvent[];
  /** Optional filter on live events of the channel. */
  filter?: (event: RunnerEvent) => boolean;
  onClose?: () => void;
  heartbeatMs?: number;
}

export interface SnapshotEvent {
  type: RunnerEventType;
  data: RunnerEventData<RunnerEventType>;
}

export function snapshot<T extends RunnerEventType>(type: T, data: RunnerEventData<T>): SnapshotEvent {
  return { type, data } as SnapshotEvent;
}

/** Opens an SSE response on a bus channel. Resolves once the stream is set up. */
export async function openSseStream(options: SseStreamOptions): Promise<void> {
  const { request, reply, bus, channel } = options;
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  let ready = false;
  let lastSentSeq = 0;
  const pending: RunnerEvent[] = [];

  const write = (frame: string) => {
    if (closed) return;
    res.write(frame);
    if (res.writableLength > MAX_PENDING_BYTES) {
      // Client too slow to read: close, it will reconnect and resynchronise.
      cleanup();
      res.end();
    }
  };
  const sendLive = (event: RunnerEvent) => {
    if (event.seq <= lastSentSeq) return;
    if (options.filter && !options.filter(event)) return;
    lastSentSeq = event.seq;
    write(encodeSseEvent(event));
  };

  const unsubscribe = bus.subscribe(channel, (event) => {
    if (closed) return;
    if (!ready) pending.push(event);
    else sendLive(event);
  });
  const heartbeat = setInterval(() => write(encodeHeartbeat()), options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    options.onClose?.();
  };
  // `request.raw` emits 'close' once the request is read: only the response tracks the client.
  res.on('close', cleanup);
  res.on('error', cleanup);

  write(`retry: ${SSE_RETRY_MS}\n\n`);

  let replayed = false;
  const header = request.headers['last-event-id'];
  const lastEventId = typeof header === 'string' && /^\d{1,20}$/.test(header) ? Number(header) : null;
  if (options.replayable && lastEventId !== null) {
    const events = bus.replay(channel, lastEventId);
    if (events === null) {
      const reason = lastEventId < bus.seqBase ? 'runner_restarted' : 'replay_unavailable';
      // Carries the current id so the next reconnection replays from now on.
      write(encodeSseEvent({ seq: bus.lastSeq, type: 'stream.reset', at: new Date().toISOString(), data: { reason } }));
      lastSentSeq = Math.max(lastSentSeq, bus.lastSeq);
    } else {
      replayed = true;
      lastSentSeq = lastEventId;
      for (const event of events) sendLive(event);
    }
  }

  try {
    const initial = (await options.initial?.({ replayed })) ?? [];
    for (const item of initial) {
      write(
        encodeSseEvent({ seq: 0, type: item.type, at: new Date().toISOString(), data: item.data } as RunnerEvent, {
          withId: false,
        }),
      );
    }
  } catch {
    // Snapshot failure: live events still flow.
  }

  ready = true;
  for (const event of pending.splice(0)) sendLive(event);
  write(encodeHeartbeat());
}
