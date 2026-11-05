import { describe, expect, it, vi } from 'vitest';
import {
  InputBatcher,
  INPUT_CHUNK_CHARS,
  RECONNECT_BACKOFF_MS,
  RUNNER_DOWN_RETRY_MS,
  buildTerminalTheme,
  clampSize,
  clipboardShortcut,
  createSseParser,
  errorText,
  exitText,
  flatten,
  keySequence,
  lineHeightFor,
  parseCssColor,
  parseTerminalStreamEvent,
  reconnectDelay,
  safeExternalUrl,
  sameSize,
  splitInput,
  stateAnnouncement,
  streamStatusError,
  toHex,
  xtermLineHeight,
  type KeyLike,
  type SseMessage,
  type TerminalTokens,
  type Timers,
} from './protocol';

/** Manual timers: `tick()` fires every due timer in order. */
function fakeTimers() {
  let now = 0;
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
    get size() {
      return pending.size;
    },
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...pending.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (entry.at <= now) {
          pending.delete(id);
          entry.handler();
        }
      }
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('SSE parser', () => {
  const collect = () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((message) => messages.push(message));
    return { messages, parser };
  };

  it('dispatches on blank lines, joins data lines, ignores comments and retry', () => {
    const { messages, parser } = collect();
    parser.push('retry: 3000\n\n: commentaire\ndata: {"a":1}\n\n');
    parser.push('id: 42\nevent: custom\ndata: ligne 1\ndata: ligne 2\n\n');
    expect(messages).toEqual([
      { data: '{"a":1}', id: null, event: null },
      { data: 'ligne 1\nligne 2', id: '42', event: 'custom' },
    ]);
  });

  it('handles any chunking, including a \\r\\n split across chunks', () => {
    const { messages, parser } = collect();
    const wire = 'data: premier\r\n\r\ndata: second\r\rdata: troisième\n\n';
    for (const char of wire) parser.push(char);
    expect(messages.map((m) => m.data)).toEqual(['premier', 'second', 'troisième']);
  });

  it('keeps a partial event until its blank line, and reset() drops it', () => {
    const { messages, parser } = collect();
    parser.push('data: incomplet');
    expect(messages).toHaveLength(0);
    parser.reset();
    parser.push('\n\ndata: suivant\n\n');
    expect(messages.map((m) => m.data)).toEqual(['suivant']);
  });

  it('refuses an endless line', () => {
    const parser = createSseParser(() => undefined, { maxBuffer: 16 });
    expect(() => parser.push('data: 0123456789abcdef0123')).toThrow();
  });
});

describe('terminal stream events', () => {
  const envelope = (type: string, data: unknown) => JSON.stringify({ seq: 0, type, at: '2026-11-05T10:00:00.000Z', data });

  it('parses the four terminal events and the relay events', () => {
    expect(parseTerminalStreamEvent(envelope('terminal.snapshot', { terminalId: 't1', data: '\u001b[1mx', cols: 120, rows: 32 }), 't1')).toEqual({
      type: 'terminal.snapshot',
      data: '\u001b[1mx',
      cols: 120,
      rows: 32,
    });
    expect(parseTerminalStreamEvent(envelope('terminal.data', { terminalId: 't1', data: 'ok' }), 't1')).toEqual({ type: 'terminal.data', data: 'ok' });
    expect(parseTerminalStreamEvent(envelope('terminal.resize', { terminalId: 't1', cols: 80, rows: 24 }))).toEqual({ type: 'terminal.resize', cols: 80, rows: 24 });
    expect(parseTerminalStreamEvent(envelope('terminal.exit', { terminalId: 't1', exitCode: 0, signal: null }))).toEqual({ type: 'terminal.exit', exitCode: 0, signal: null });
    expect(parseTerminalStreamEvent(envelope('heartbeat', {}))).toEqual({ type: 'heartbeat' });
    expect(parseTerminalStreamEvent(envelope('stream.error', { code: 'RUNNER_UNAVAILABLE', message: 'VPS-3 ne répond pas' }))).toEqual({
      type: 'stream.error',
      code: 'RUNNER_UNAVAILABLE',
      message: 'VPS-3 ne répond pas',
    });
  });

  it('rejects malformed events and events of another terminal', () => {
    expect(parseTerminalStreamEvent('pas du json')).toBeNull();
    expect(parseTerminalStreamEvent(envelope('terminal.data', { terminalId: 't1', data: 42 }))).toBeNull();
    expect(parseTerminalStreamEvent(envelope('terminal.snapshot', { data: 'x', cols: 1.5, rows: 3 }))).toBeNull();
    expect(parseTerminalStreamEvent(envelope('terminal.exit', { exitCode: 'zéro', signal: null }))).toBeNull();
    expect(parseTerminalStreamEvent(envelope('terminal.data', { terminalId: 'autre', data: 'x' }), 't1')).toBeNull();
    expect(parseTerminalStreamEvent(envelope('session.status', { sessionId: 'x' }))).toBeNull();
  });
});

describe('reconnection', () => {
  it('backs off 1 → 30 s with ±20 % jitter, 10 s while the runner is down', () => {
    expect(reconnectDelay(1, { random: () => 0.5 })).toBe(1_000);
    expect(reconnectDelay(2, { random: () => 0.5 })).toBe(2_000);
    expect(reconnectDelay(50, { random: () => 0.5 })).toBe(30_000);
    expect(reconnectDelay(1, { random: () => 0 })).toBe(800);
    expect(reconnectDelay(1, { random: () => 1 })).toBe(1_200);
    expect(reconnectDelay(3, { runnerDown: true })).toBe(RUNNER_DOWN_RETRY_MS);
    expect(RECONNECT_BACKOFF_MS.at(-1)).toBe(30_000);
  });

  it('maps final HTTP statuses (no retry) and leaves the others transient', () => {
    expect(streamStatusError(401)).toBe('unauthorized');
    expect(streamStatusError(403)).toBe('forbidden');
    expect(streamStatusError(404)).toBe('closed');
    expect(streamStatusError(409)).toBe('closed');
    expect(streamStatusError(422)).toBe('invalid');
    expect(streamStatusError(500)).toBeNull();
    expect(streamStatusError(503)).toBeNull();
    expect(streamStatusError(200)).toBeNull();
  });
});

describe('input batching', () => {
  function setup(send: (data: string) => Promise<void> = async () => undefined) {
    const clock = fakeTimers();
    const sent: string[] = [];
    const errors: unknown[] = [];
    const batcher = new InputBatcher({
      send: async (data) => {
        sent.push(data);
        await send(data);
      },
      onError: (error) => errors.push(error),
      timers: clock.timers,
    });
    return { clock, sent, errors, batcher };
  }

  it('groups what is typed within 10 ms into one request', async () => {
    const { clock, sent, batcher } = setup();
    batcher.push('l');
    batcher.push('s');
    batcher.push('\r');
    expect(sent).toEqual([]);
    clock.advance(9);
    expect(sent).toEqual([]);
    clock.advance(1);
    await flush();
    expect(sent).toEqual(['ls\r']);
    expect(batcher.idle).toBe(true);
  });

  it('keeps the order with one request in flight at a time', async () => {
    const gates: Array<() => void> = [];
    const { clock, sent, batcher } = setup(() => new Promise<void>((resolve) => gates.push(resolve)));
    batcher.push('a');
    clock.advance(10);
    await flush();
    expect(sent).toEqual(['a']);
    batcher.push('b');
    batcher.push('c');
    clock.advance(50);
    await flush();
    expect(sent).toEqual(['a']);
    gates.shift()?.();
    await flush();
    expect(sent).toEqual(['a', 'bc']);
    gates.shift()?.();
    await flush();
    expect(batcher.idle).toBe(true);
  });

  it('sends a lone Échap / Ctrl+C on its own and at once (runner « Interrompre »)', async () => {
    const { sent, batcher } = setup();
    batcher.push('abc');
    batcher.push('\u001b');
    await flush();
    expect(sent).toEqual(['abc', '\u001b']);
    batcher.push('\u0003');
    await flush();
    expect(sent).toEqual(['abc', '\u001b', '\u0003']);
  });

  it('splits big pastes without cutting a surrogate pair', async () => {
    const { sent, batcher } = setup();
    const big = 'x'.repeat(INPUT_CHUNK_CHARS - 1) + '😀' + 'y'.repeat(10);
    batcher.push(big);
    await flush();
    expect(sent.join('')).toBe(big);
    expect(sent.every((chunk) => chunk.length <= INPUT_CHUNK_CHARS)).toBe(true);
    expect(sent[0]!.endsWith('\ud83d')).toBe(false);
    expect(splitInput('', 4)).toEqual([]);
    expect(splitInput('abcdef', 4)).toEqual(['abcd', 'ef']);
  });

  it('drops the pending input after a failed request, then works again', async () => {
    const failures = [new Error('réseau')];
    const { clock, sent, errors, batcher } = setup(async () => {
      const failure = failures.shift();
      if (failure) throw failure;
    });
    batcher.push('perdu');
    clock.advance(10);
    await flush();
    expect(errors).toHaveLength(1);
    batcher.push('ok');
    clock.advance(10);
    await flush();
    expect(sent).toEqual(['perdu', 'ok']);
  });

  it('ignores everything once disposed', async () => {
    const { clock, sent, batcher } = setup();
    batcher.push('a');
    batcher.dispose();
    batcher.push('b');
    clock.advance(20);
    await flush();
    expect(sent).toEqual([]);
    expect(clock.size).toBe(0);
  });
});

describe('sizes', () => {
  it('clamps to the contract bounds and rejects unusable measures', () => {
    expect(clampSize({ cols: 80.7, rows: 24.2 })).toEqual({ cols: 80, rows: 24 });
    expect(clampSize({ cols: 3, rows: 1 })).toEqual({ cols: 10, rows: 4 });
    expect(clampSize({ cols: 900, rows: 900 })).toEqual({ cols: 500, rows: 300 });
    expect(clampSize({ cols: Number.NaN, rows: 10 })).toBeNull();
    expect(clampSize({ cols: 0, rows: 10 })).toBeNull();
    expect(clampSize(undefined)).toBeNull();
    expect(sameSize({ cols: 1, rows: 2 }, { cols: 1, rows: 2 })).toBe(true);
    expect(sameSize({ cols: 1, rows: 2 }, null)).toBe(false);
  });

  it('pairs Figma line heights and converts them for xterm', () => {
    expect(lineHeightFor(13)).toBe(21);
    expect(lineHeightFor(11)).toBe(17);
    expect(lineHeightFor(12)).toBe(18);
    expect(lineHeightFor(15)).toBe(24);
    // JetBrains Mono 13 px: char box ≈ 17.16 px → rows of exactly 21 px at 1× and 2×.
    for (const dpr of [1, 2, 3]) {
      const lh = xtermLineHeight(21, 17.16, dpr);
      expect(Math.floor(Math.ceil(17.16 * dpr) * lh) / dpr).toBeCloseTo(21, 0);
    }
    expect(xtermLineHeight(21, 0)).toBe(1.2);
  });
});

describe('keys and clipboard', () => {
  it('maps the phone key bar, arrows following DECCKM', () => {
    expect(keySequence('escape')).toBe('\u001b');
    expect(keySequence('ctrl-c')).toBe('\u0003');
    expect(keySequence('tab')).toBe('\t');
    expect(keySequence('up')).toBe('\u001b[A');
    expect(keySequence('left')).toBe('\u001b[D');
    expect(keySequence('down', { applicationCursor: true })).toBe('\u001bOB');
    expect(keySequence('right', { applicationCursor: true })).toBe('\u001bOC');
  });

  const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ type: 'keydown', key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

  it('copies with Ctrl+C only when text is selected, pastes through the browser', () => {
    const pc = { isMac: false, hasSelection: false };
    expect(clipboardShortcut(key('c', { ctrlKey: true }), pc)).toBeNull();
    expect(clipboardShortcut(key('c', { ctrlKey: true }), { ...pc, hasSelection: true })).toBe('copy');
    expect(clipboardShortcut(key('C', { ctrlKey: true, shiftKey: true }), pc)).toBe('copy');
    expect(clipboardShortcut(key('Insert', { ctrlKey: true }), { ...pc, hasSelection: true })).toBe('copy');
    expect(clipboardShortcut(key('v', { ctrlKey: true }), pc)).toBe('paste');
    expect(clipboardShortcut(key('V', { ctrlKey: true, shiftKey: true }), pc)).toBe('paste');
    expect(clipboardShortcut(key('Insert', { shiftKey: true }), pc)).toBe('paste');
    expect(clipboardShortcut({ ...key('v', { ctrlKey: true }), type: 'keyup' }, pc)).toBeNull();
    expect(clipboardShortcut(key('a', { ctrlKey: true }), pc)).toBeNull();
    // macOS: ⌘C / ⌘V stay native, Ctrl+C is always the terminal's.
    expect(clipboardShortcut(key('c', { metaKey: true }), { isMac: true, hasSelection: true })).toBeNull();
    expect(clipboardShortcut(key('c', { ctrlKey: true }), { isMac: true, hasSelection: true })).toBeNull();
  });

  it('opens only http(s) links without credentials', () => {
    expect(safeExternalUrl('https://claude.ai/oauth/authorize?fake=1')).toBe('https://claude.ai/oauth/authorize?fake=1');
    expect(safeExternalUrl(' http://localhost:3000/x ')).toBe('http://localhost:3000/x');
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('file:///etc/passwd')).toBeNull();
    expect(safeExternalUrl('https://user:pass@example.com')).toBeNull();
    expect(safeExternalUrl('pas une url')).toBeNull();
  });
});

describe('theme from the dark tokens', () => {
  it('parses computed colours', () => {
    expect(parseCssColor('rgb(35, 51, 83)')).toEqual({ r: 35, g: 51, b: 83, a: 1 });
    expect(parseCssColor('rgba(255, 255, 255, 0.62)')).toEqual({ r: 255, g: 255, b: 255, a: 0.62 });
    expect(parseCssColor('rgb(255 255 255 / 14%)')).toEqual({ r: 255, g: 255, b: 255, a: 0.14 });
    expect(parseCssColor('#ffffff9e')).toEqual({ r: 255, g: 255, b: 255, a: 158 / 255 });
    expect(parseCssColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseCssColor('color(srgb 1 0.5 0)')).toEqual({ r: 255, g: 128, b: 0, a: 1 });
    expect(parseCssColor('chartreuse')).toBeNull();
    expect(parseCssColor('')).toBeNull();
  });

  it('maps the tokens of W2 (white text, 62 % muted flattened, accent, danger-pale failures)', () => {
    const c = (value: string) => parseCssColor(value)!;
    const tokens: TerminalTokens = {
      bg: c('#233353'),
      text: c('#ffffff'),
      muted: c('#ffffff9e'),
      accent: c('#a6b9dd'),
      border: c('#ffffff24'),
      nearBlack: c('#141830'),
      danger: c('#f8e6de'),
      success: c('#5fc48b'),
      warn: c('#f2c14e'),
    };
    const theme = buildTerminalTheme(tokens);
    expect(theme.background).toBe('#233353');
    expect(theme.foreground).toBe('#ffffff');
    expect(theme.cursor).toBe('#a6b9dd');
    expect(theme.red).toBe('#f8e6de');
    expect(theme.green).toBe('#5fc48b');
    expect(theme.yellow).toBe('#f2c14e');
    expect(theme.blue).toBe('#a6b9dd');
    expect(theme.black).toBe('#141830');
    // 62 % white over ink, opaque (xterm dims text itself).
    expect(theme.brightBlack).toBe(toHex(flatten(tokens.muted, tokens.bg)));
    expect(theme.brightBlack).toMatch(/^#[0-9a-f]{6}$/);
    expect(theme.selectionBackground).toMatch(/^#a6b9dd[0-9a-f]{2}$/);
    for (const value of Object.values(theme)) expect(typeof value === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(value)).toBe(true);
  });
});

describe('copy', () => {
  it('says what happened in sober French', () => {
    expect(exitText(0)).toBe('Processus terminé · code 0');
    expect(exitText(null)).toBe('Processus terminé');
    expect(errorText('closed')).toBe('Ce terminal est fermé.');
    expect(stateAnnouncement('live')).toBe('Terminal connecté.');
    expect(stateAnnouncement('live', { wasLive: true })).toBe('Terminal reconnecté.');
    expect(stateAnnouncement('reconnecting', { wasLive: true })).toMatch(/perdue/);
    expect(stateAnnouncement('exited', { exitCode: 130 })).toBe('Processus terminé · code 130.');
    expect(stateAnnouncement('connecting')).toBeNull();
    for (const text of [exitText(1), errorText('unauthorized'), stateAnnouncement('error', { error: 'forbidden' })]) {
      expect(text).not.toContain('’');
    }
  });

  it('never logs terminal bytes', () => {
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const parser = createSseParser(() => undefined);
    parser.push('data: {"type":"terminal.data","data":{"data":"secret"}}\n\n');
    parseTerminalStreamEvent('{"type":"terminal.data","data":{"data":"secret"}}');
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
