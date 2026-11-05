import type { RunnerEvent, RunnerEventData, RunnerEventType } from '@nuera/shared/events';

/**
 * In-process event bus feeding every SSE stream.
 *
 * - `seq` is strictly increasing and starts at `Date.now() * 1000` so that ids stay monotonic across
 *   runner restarts: a `Last-Event-ID` from a previous instance is recognised (→ `stream.reset`).
 * - Replayable events are kept in a ring buffer (per channel lookup on replay).
 * - High-volume events (terminal bytes, run output) are published as non-replayable: terminal
 *   streams resynchronise with a snapshot, run streams with the output tail.
 */

export type Channel = string;
export const GLOBAL: Channel = 'global';
export const sessionChannel = (id: string): Channel => `session:${id}`;
export const terminalChannel = (id: string): Channel => `terminal:${id}`;
export const runChannel = (id: string): Channel => `run:${id}`;
export const operationChannel = (id: string): Channel => `operation:${id}`;

interface StoredEvent {
  event: RunnerEvent;
  channels: readonly Channel[];
}

export type Listener = (event: RunnerEvent) => void;

export class EventBus {
  readonly seqBase: number;
  private counter = 0;
  private evictedUpTo = 0;
  private readonly ring: StoredEvent[] = [];
  private readonly listeners = new Map<Channel, Set<Listener>>();
  private readonly capacity: number;
  private readonly subscriptionHooks = new Set<(channel: Channel, count: number) => void>();

  constructor(options: { capacity?: number; seqBase?: number } = {}) {
    this.capacity = options.capacity ?? 5000;
    this.seqBase = options.seqBase ?? Date.now() * 1000;
  }

  get lastSeq(): number {
    return this.seqBase + this.counter;
  }

  publish<T extends RunnerEventType>(
    type: T,
    data: RunnerEventData<T>,
    options: { channels: readonly Channel[]; replay?: boolean },
  ): RunnerEvent {
    this.counter += 1;
    const event = { seq: this.seqBase + this.counter, type, at: new Date().toISOString(), data } as RunnerEvent;
    if (options.replay ?? true) {
      this.ring.push({ event, channels: options.channels });
      if (this.ring.length > this.capacity) {
        const evicted = this.ring.splice(0, this.ring.length - this.capacity);
        this.evictedUpTo = evicted[evicted.length - 1]?.event.seq ?? this.evictedUpTo;
      }
    }
    for (const channel of options.channels) {
      const set = this.listeners.get(channel);
      if (!set) continue;
      // eslint-disable-next-line unicorn/no-useless-spread -- snapshot: a listener may unsubscribe while we iterate
      for (const listener of [...set]) {
        try {
          listener(event);
        } catch {
          // a broken subscriber never breaks the publisher
        }
      }
    }
    return event;
  }

  subscribe(channel: Channel, listener: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    this.notifySubscription(channel);
    return () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(channel);
      this.notifySubscription(channel);
    };
  }

  subscriberCount(channel: Channel): number {
    return this.listeners.get(channel)?.size ?? 0;
  }

  /** Called whenever the number of subscribers of a channel changes. */
  onSubscriptionChange(hook: (channel: Channel, count: number) => void): () => void {
    this.subscriptionHooks.add(hook);
    return () => this.subscriptionHooks.delete(hook);
  }

  private notifySubscription(channel: Channel) {
    const count = this.subscriberCount(channel);
    for (const hook of this.subscriptionHooks) hook(channel, count);
  }

  /**
   * Events of `channel` with `seq > afterSeq`, or `null` when they cannot all be replayed (id from
   * a previous runner instance, or older than the ring buffer).
   */
  replay(channel: Channel, afterSeq: number): RunnerEvent[] | null {
    if (!Number.isFinite(afterSeq) || afterSeq < this.seqBase) return null;
    if (afterSeq > this.lastSeq) return null;
    // Some replayable events after `afterSeq` were dropped from the ring.
    if (afterSeq < this.evictedUpTo) return null;
    return this.ring.filter((s) => s.event.seq > afterSeq && s.channels.includes(channel)).map((s) => s.event);
  }
}
