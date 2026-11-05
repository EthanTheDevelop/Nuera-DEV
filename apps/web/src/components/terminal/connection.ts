/**
 * Live connection of one browser terminal to its SSE relay (`/api/stream/terminals/[id]`), without
 * React nor xterm (unit-tested in `connection.test.ts` with fake fetch streams and timers).
 *
 * - `fetch` streaming rather than EventSource: the HTTP status tells « closed » (404/409),
 *   « signed out » (401/403) and « unreachable » apart, and reconnection is ours.
 * - Every (re)connection starts with a fresh `terminal.snapshot` (screen + scrollback): the view
 *   resets and repaints, nothing is replayed.
 * - Reconnection with back-off (1 → 30 s ± 20 %, 10 s while the runner is down), a silence
 *   watchdog (2.5 heartbeats), `retryNow()`, immediate retry when the page comes back online.
 * - `exited` (terminal.exit) and `error` (closed, signed out…) are final: no retry.
 */

import {
  createSseParser,
  parseTerminalStreamEvent,
  reconnectDelay,
  STREAM_SILENCE_TIMEOUT_MS,
  streamStatusError,
  defaultTimers,
  type TerminalErrorReason,
  type TerminalSize,
  type TerminalViewState,
  type Timers,
} from './protocol';

export interface TerminalConnectionStatus {
  state: TerminalViewState;
  /** Consecutive failed attempts since the last snapshot. */
  attempt: number;
  /** When the next automatic attempt happens (ms epoch), while `reconnecting`. */
  nextRetryAt: number | null;
  /** The relay reported the runner unreachable (`stream.error` RUNNER_UNAVAILABLE). */
  runnerDown: boolean;
  /** At least one snapshot was received (the screen holds real content). */
  wasLive: boolean;
  exitCode: number | null;
  signal: number | null;
  error: TerminalErrorReason | null;
}

export interface TerminalConnectionHandlers {
  /** Reset the screen, resize to `cols × rows`, then write `data`. */
  onSnapshot(snapshot: { data: string; cols: number; rows: number }): void;
  onData(data: string): void;
  /** The PTY was resized (by this or another client). */
  onResize(size: TerminalSize): void;
  onExit(exit: { exitCode: number | null; signal: number | null }): void;
  onStatus(status: TerminalConnectionStatus): void;
}

export interface TerminalConnectionOptions extends TerminalConnectionHandlers {
  streamUrl: string;
  /** Ignore events addressed to another terminal (defensive). */
  terminalId?: string;
  fetch?: typeof fetch;
  timers?: Timers;
  now?: () => number;
  random?: () => number;
  silenceTimeoutMs?: number;
}

const INITIAL_STATUS: TerminalConnectionStatus = {
  state: 'connecting',
  attempt: 0,
  nextRetryAt: null,
  runnerDown: false,
  wasLive: false,
  exitCode: null,
  signal: null,
  error: null,
};

export class TerminalConnection {
  private status: TerminalConnectionStatus = { ...INITIAL_STATUS };
  private abort: AbortController | null = null;
  private generation = 0;
  private retryTimer: unknown = null;
  private watchdog: unknown = null;
  private lastSignalAt = 0;
  private started = false;
  private disposed = false;
  private readonly fetchImpl: typeof fetch;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly silenceTimeoutMs: number;

  constructor(private readonly options: TerminalConnectionOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? STREAM_SILENCE_TIMEOUT_MS;
  }

  get current(): TerminalConnectionStatus {
    return this.status;
  }

  /** True once the connection reached `exited` or `error` (or was disposed). */
  get finished(): boolean {
    return this.disposed || this.status.state === 'exited' || this.status.state === 'error';
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.options.onStatus(this.status);
    void this.connect();
  }

  /** « Réessayer maintenant »: reconnects at once (only while reconnecting). */
  retryNow(): void {
    if (this.finished || this.status.state !== 'reconnecting') return;
    this.clearRetry();
    void this.connect();
  }

  /** The page is back online / visible: do not wait for the back-off. */
  nudge(): void {
    if (this.status.state === 'reconnecting') this.retryNow();
  }

  /**
   * The browser went offline: drop the stream now instead of waiting for the silence watchdog
   * (a stalled socket can look open for a long time). Reconnects with back-off, or at once on `nudge()`.
   */
  drop(): void {
    if (this.finished || !this.started || this.status.state === 'reconnecting') return;
    this.lost(this.generation, false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.clearRetry();
    this.clearWatchdog();
    this.abort?.abort();
    this.abort = null;
  }

  // ---------------------------------------------------------------------------------------------

  private setStatus(patch: Partial<TerminalConnectionStatus>) {
    this.status = { ...this.status, ...patch };
    if (!this.disposed) this.options.onStatus(this.status);
  }

  private clearRetry() {
    if (this.retryTimer !== null) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearWatchdog() {
    if (this.watchdog !== null) {
      this.timers.clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  /** Silence watchdog: no byte at all (heartbeats included) for `silenceTimeoutMs` ⇒ lost. */
  private armWatchdog(generation: number, ms = this.silenceTimeoutMs) {
    this.clearWatchdog();
    this.watchdog = this.timers.setTimeout(() => {
      this.watchdog = null;
      if (generation !== this.generation || this.finished) return;
      const silentFor = this.now() - this.lastSignalAt;
      if (silentFor >= this.silenceTimeoutMs) this.lost(generation, false);
      else this.armWatchdog(generation, this.silenceTimeoutMs - silentFor);
    }, Math.max(1, ms));
  }

  private async connect(): Promise<void> {
    if (this.finished) return;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const generation = ++this.generation;
    this.lastSignalAt = this.now();
    this.armWatchdog(generation);
    if (this.status.state === 'reconnecting' && this.status.nextRetryAt !== null) this.setStatus({ nextRetryAt: null });

    let response: Response;
    try {
      response = await this.fetchImpl(this.options.streamUrl, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        cache: 'no-store',
        credentials: 'same-origin',
        signal: abort.signal,
      });
    } catch {
      if (generation === this.generation) this.lost(generation, false);
      return;
    }
    if (generation !== this.generation) {
      abort.abort();
      return;
    }

    const final = streamStatusError(response.status);
    if (final) {
      void response.body?.cancel().catch(() => undefined);
      this.fail(final);
      return;
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      this.lost(generation, false);
      return;
    }

    let runnerDown = false;
    const decoder = new TextDecoder();
    const parser = createSseParser((message) => {
      if (generation !== this.generation || this.finished) return;
      const event = parseTerminalStreamEvent(message.data, this.options.terminalId);
      if (!event) return;
      switch (event.type) {
        case 'terminal.snapshot':
          this.options.onSnapshot({ data: event.data, cols: event.cols, rows: event.rows });
          this.setStatus({ state: 'live', attempt: 0, nextRetryAt: null, runnerDown: false, wasLive: true });
          break;
        case 'terminal.data':
          if (this.status.state === 'live') this.options.onData(event.data);
          break;
        case 'terminal.resize':
          if (this.status.state === 'live') this.options.onResize({ cols: event.cols, rows: event.rows });
          break;
        case 'terminal.exit':
          this.exit(event.exitCode, event.signal);
          break;
        case 'stream.error':
          runnerDown = event.code === 'RUNNER_UNAVAILABLE';
          break;
        case 'heartbeat':
        case 'stream.reset':
          break;
      }
    });

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (generation !== this.generation || this.finished) {
          void reader.cancel().catch(() => undefined);
          return;
        }
        if (done) break;
        this.lastSignalAt = this.now();
        if (value && value.byteLength > 0) parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
    } catch {
      // network drop, abort, or an unreadable stream: handled below
    }
    if (generation === this.generation && !this.finished) this.lost(generation, runnerDown);
  }

  private lost(generation: number, runnerDown: boolean) {
    if (generation !== this.generation || this.finished) return;
    this.abort?.abort();
    this.abort = null;
    this.clearWatchdog();
    this.clearRetry();
    const attempt = this.status.attempt + 1;
    const delay = reconnectDelay(attempt, { runnerDown, random: this.random });
    this.generation += 1;
    this.setStatus({ state: 'reconnecting', attempt, nextRetryAt: this.now() + delay, runnerDown });
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private exit(exitCode: number | null, signal: number | null) {
    this.generation += 1;
    this.clearRetry();
    this.clearWatchdog();
    this.abort?.abort();
    this.abort = null;
    this.setStatus({ state: 'exited', exitCode, signal, nextRetryAt: null, runnerDown: false });
    this.options.onExit({ exitCode, signal });
  }

  private fail(reason: TerminalErrorReason) {
    this.generation += 1;
    this.clearRetry();
    this.clearWatchdog();
    this.abort?.abort();
    this.abort = null;
    this.setStatus({ state: 'error', error: reason, nextRetryAt: null });
  }
}
