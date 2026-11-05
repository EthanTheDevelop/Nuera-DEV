import { describe, expect, it } from 'vitest';
import { TerminalConnection, type TerminalConnectionStatus } from './connection';
import type { Timers } from './protocol';

/* Fake clock for the connection's timers (the event loop itself stays real). */
function fakeClock() {
  let now = 1_000_000;
  let nextId = 1;
  const pending = new Map<number, { at: number; handler: () => void }>();
  const timers: Timers = {
    setTimeout: (handler, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, handler });
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id as number);
    },
  };
  return {
    timers,
    now: () => now,
    pendingDelays: () => [...pending.values()].map((entry) => entry.at - now).sort((a, b) => a - b),
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].handler();
      }
      now = target;
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await tick();
};

const encoder = new TextEncoder();
const frame = (type: string, data: unknown) => `data: ${JSON.stringify({ seq: 0, type, at: '2026-11-05T10:00:00.000Z', data })}\n\n`;

/** One SSE response whose body the test drives; aborting the request errors the body like fetch does. */
function sseStream(signal: AbortSignal | null | undefined) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  signal?.addEventListener('abort', () => {
    if (!open) return;
    open = false;
    controller.error(new DOMException('aborted', 'AbortError'));
  });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    write(text: string) {
      if (open) controller.enqueue(encoder.encode(text));
    },
    send(type: string, data: unknown) {
      this.write(frame(type, data));
    },
    end() {
      if (!open) return;
      open = false;
      controller.close();
    },
    fail() {
      if (!open) return;
      open = false;
      controller.error(new TypeError('network error'));
    },
  };
}

type Stream = ReturnType<typeof sseStream>;
type Reply = { kind: 'stream' } | { kind: 'status'; status: number } | { kind: 'reject' };

function setup(replies: Reply[] = []) {
  const clock = fakeClock();
  const streams: Stream[] = [];
  const queue = [...replies];
  const calls: string[] = [];
  const statuses: TerminalConnectionStatus[] = [];
  const snapshots: Array<{ data: string; cols: number; rows: number }> = [];
  const data: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const exits: Array<{ exitCode: number | null; signal: number | null }> = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    const reply = queue.shift() ?? { kind: 'stream' };
    if (reply.kind === 'reject') throw new TypeError('Failed to fetch');
    if (reply.kind === 'status') {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Terminal introuvable ou fermé.' } }), { status: reply.status });
    }
    const stream = sseStream(init?.signal);
    streams.push(stream);
    return stream.response;
  }) as typeof fetch;

  const connection = new TerminalConnection({
    streamUrl: '/api/stream/terminals/abcdefgh12',
    terminalId: 'abcdefgh12',
    fetch: fetchImpl,
    timers: clock.timers,
    now: clock.now,
    random: () => 0.5,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onData: (chunk) => data.push(chunk),
    onResize: (size) => resizes.push(size),
    onExit: (exit) => exits.push(exit),
    onStatus: (status) => statuses.push(status),
  });
  const last = () => statuses.at(-1)!;
  return { clock, streams, calls, statuses, snapshots, data, resizes, exits, connection, last };
}

const snapshot = (text = 'écran') => ({ terminalId: 'abcdefgh12', data: text, cols: 120, rows: 32 });

describe('TerminalConnection', () => {
  it('connects, draws the snapshot, then data, resizes and the exit (final, no retry)', async () => {
    const t = setup();
    t.connection.start();
    expect(t.last().state).toBe('connecting');
    await settle();
    expect(t.calls).toEqual(['/api/stream/terminals/abcdefgh12']);

    const stream = t.streams[0]!;
    stream.send('terminal.data', { terminalId: 'abcdefgh12', data: 'avant' }); // before the snapshot: ignored
    stream.send('terminal.snapshot', snapshot('$ '));
    stream.send('terminal.data', { terminalId: 'abcdefgh12', data: 'ls\r\n' });
    stream.send('terminal.data', { terminalId: 'autre-terminal', data: 'intrus' });
    stream.send('terminal.resize', { terminalId: 'abcdefgh12', cols: 80, rows: 24 });
    await settle();
    expect(t.snapshots).toEqual([{ data: '$ ', cols: 120, rows: 32 }]);
    expect(t.data).toEqual(['ls\r\n']);
    expect(t.resizes).toEqual([{ cols: 80, rows: 24 }]);
    expect(t.last()).toMatchObject({ state: 'live', attempt: 0, wasLive: true });

    stream.send('terminal.exit', { terminalId: 'abcdefgh12', exitCode: 0, signal: null });
    await settle();
    expect(t.exits).toEqual([{ exitCode: 0, signal: null }]);
    expect(t.last()).toMatchObject({ state: 'exited', exitCode: 0 });
    t.clock.advance(120_000);
    await settle();
    expect(t.calls).toHaveLength(1);
    expect(t.connection.finished).toBe(true);
  });

  it('reconnects with back-off after a drop and repaints from a fresh snapshot', async () => {
    const t = setup();
    t.connection.start();
    await settle();
    t.streams[0]!.send('terminal.snapshot', snapshot('un'));
    await settle();
    t.streams[0]!.end();
    await settle();
    expect(t.last()).toMatchObject({ state: 'reconnecting', attempt: 1, wasLive: true, runnerDown: false });
    expect(t.last().nextRetryAt).toBe(t.clock.now() + 1_000);

    t.clock.advance(999);
    await settle();
    expect(t.calls).toHaveLength(1);
    t.clock.advance(1);
    await settle();
    expect(t.calls).toHaveLength(2);
    t.streams[1]!.send('terminal.snapshot', snapshot('deux'));
    await settle();
    expect(t.snapshots.map((s) => s.data)).toEqual(['un', 'deux']);
    expect(t.last()).toMatchObject({ state: 'live', attempt: 0 });
  });

  it('grows the delay on repeated failures and retries at once on demand', async () => {
    const t = setup([{ kind: 'reject' }, { kind: 'reject' }, { kind: 'reject' }]);
    t.connection.start();
    await settle();
    expect(t.last()).toMatchObject({ state: 'reconnecting', attempt: 1, wasLive: false });
    t.clock.advance(1_000);
    await settle();
    expect(t.last()).toMatchObject({ state: 'reconnecting', attempt: 2 });
    expect(t.last().nextRetryAt).toBe(t.clock.now() + 2_000);

    t.connection.retryNow();
    await settle();
    expect(t.calls).toHaveLength(3);
    expect(t.last()).toMatchObject({ state: 'reconnecting', attempt: 3 });
    t.clock.advance(4_000);
    await settle();
    expect(t.calls).toHaveLength(4);
    t.streams[0]!.send('terminal.snapshot', snapshot());
    await settle();
    expect(t.last()).toMatchObject({ state: 'live', attempt: 0 });
  });

  it('waits 10 s between attempts while the relay says the runner is down', async () => {
    const t = setup();
    t.connection.start();
    await settle();
    t.streams[0]!.send('stream.error', { code: 'RUNNER_UNAVAILABLE', message: 'VPS-3 ne répond pas : le runner est injoignable.' });
    t.streams[0]!.send('heartbeat', {});
    t.streams[0]!.end();
    await settle();
    expect(t.last()).toMatchObject({ state: 'reconnecting', runnerDown: true });
    expect(t.last().nextRetryAt).toBe(t.clock.now() + 10_000);
  });

  it('ends in error without retrying when the terminal is gone or the session is over', async () => {
    for (const [status, reason] of [
      [404, 'closed'],
      [409, 'closed'],
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [422, 'invalid'],
    ] as const) {
      const t = setup([{ kind: 'status', status }]);
      t.connection.start();
      await settle();
      expect(t.last(), `HTTP ${status}`).toMatchObject({ state: 'error', error: reason });
      t.clock.advance(60_000);
      await settle();
      expect(t.calls).toHaveLength(1);
    }
  });

  it('retries a 5xx answer (transient)', async () => {
    const t = setup([{ kind: 'status', status: 502 }]);
    t.connection.start();
    await settle();
    expect(t.last()).toMatchObject({ state: 'reconnecting', attempt: 1 });
  });

  it('treats a silent connection as lost (no byte for 2.5 heartbeats), heartbeats keep it alive', async () => {
    const t = setup();
    t.connection.start();
    await settle();
    t.streams[0]!.send('terminal.snapshot', snapshot());
    await settle();
    for (let i = 0; i < 4; i += 1) {
      t.clock.advance(15_000);
      t.streams[0]!.send('heartbeat', {});
      await settle();
    }
    expect(t.last().state).toBe('live');
    t.clock.advance(37_500);
    await settle();
    expect(t.last()).toMatchObject({ state: 'reconnecting', attempt: 1 });
  });

  it('a network error in the middle of the stream reconnects too', async () => {
    const t = setup();
    t.connection.start();
    await settle();
    t.streams[0]!.send('terminal.snapshot', snapshot());
    await settle();
    t.streams[0]!.fail();
    await settle();
    expect(t.last()).toMatchObject({ state: 'reconnecting', attempt: 1 });
  });

  it('drop() (browser offline) shows the loss at once, nudge() (online) reconnects at once', async () => {
    const t = setup();
    t.connection.drop(); // not started: nothing
    expect(t.statuses).toHaveLength(0);
    t.connection.start();
    await settle();
    t.streams[0]!.send('terminal.snapshot', snapshot('avant'));
    await settle();
    t.connection.drop();
    await settle();
    expect(t.last()).toMatchObject({ state: 'reconnecting', attempt: 1, wasLive: true });
    t.connection.drop(); // already reconnecting: no extra attempt
    expect(t.last().attempt).toBe(1);
    t.connection.nudge();
    await settle();
    expect(t.calls).toHaveLength(2);
    t.streams[1]!.send('terminal.snapshot', snapshot('après'));
    await settle();
    expect(t.last()).toMatchObject({ state: 'live', attempt: 0 });
    expect(t.snapshots.map((s) => s.data)).toEqual(['avant', 'après']);
  });

  it('nudge() skips the back-off, dispose() stops everything', async () => {
    const t = setup([{ kind: 'reject' }]);
    t.connection.start();
    await settle();
    expect(t.last().state).toBe('reconnecting');
    t.connection.nudge();
    await settle();
    expect(t.calls).toHaveLength(2);
    const before = t.statuses.length;
    t.connection.dispose();
    t.streams[0]?.send('terminal.snapshot', snapshot());
    t.clock.advance(120_000);
    await settle();
    expect(t.statuses.length).toBe(before);
    expect(t.snapshots).toHaveLength(0);
    expect(t.clock.pendingDelays()).toEqual([]);
  });
});
