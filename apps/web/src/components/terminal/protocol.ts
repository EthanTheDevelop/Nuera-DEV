/**
 * Pure logic of the browser terminal (no DOM, no React, no xterm instance): SSE framing, terminal
 * stream events, reconnection back-off, ordered input batching, resize policy helpers, phone key
 * sequences, clipboard shortcuts, links, line height and theme colour maths. Unit-tested in
 * `protocol.test.ts`; used by `connection.ts` and `TerminalView.tsx`.
 *
 * Never log terminal bytes (input or output): login terminals carry codes pasted by the owner.
 */

import type { ITheme } from '@xterm/xterm';

/** State of a `TerminalView` (exposed through `onStateChange` and `data-terminal-state`). */
export type TerminalViewState = 'connecting' | 'live' | 'reconnecting' | 'exited' | 'error';

/** Why a terminal ended in the `error` state (no automatic retry). */
export type TerminalErrorReason = 'closed' | 'unauthorized' | 'forbidden' | 'invalid';

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** Bounds of `TerminalSizeSchema` (@nuera/shared/runner). */
export const TERMINAL_SIZE_LIMITS = { minCols: 10, maxCols: 500, minRows: 4, maxRows: 300 } as const;

/* -------------------------------------------------------------------------------------------------
   SSE framing (WHATWG event-stream: `data:` lines, blank line = dispatch, `:` comments)
   ------------------------------------------------------------------------------------------------- */

export interface SseMessage {
  data: string;
  id: string | null;
  event: string | null;
}

export interface SseParser {
  /** Feeds decoded text (any chunking, `\n`, `\r\n` or `\r` line endings). */
  push(chunk: string): void;
  /** Drops any partial line / event (new connection). */
  reset(): void;
}

/** Above this many buffered characters without a line end, the stream is considered broken. */
export const SSE_MAX_BUFFER = 32 * 1024 * 1024;

export function createSseParser(onMessage: (message: SseMessage) => void, options: { maxBuffer?: number } = {}): SseParser {
  const maxBuffer = options.maxBuffer ?? SSE_MAX_BUFFER;
  let buffer = '';
  let scanFrom = 0;
  let data: string[] = [];
  let eventName: string | null = null;
  let lastId: string | null = null;

  const dispatch = () => {
    if (data.length > 0) {
      const message: SseMessage = { data: data.join('\n'), id: lastId, event: eventName };
      data = [];
      eventName = null;
      onMessage(message);
    } else {
      eventName = null;
    }
  };

  const processLine = (line: string) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        data.push(value);
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        if (!value.includes('\u0000')) lastId = value;
        break;
      default:
        // `retry:` and unknown fields are ignored (the connection drives its own back-off).
        break;
    }
  };

  return {
    push(chunk: string) {
      if (!chunk) return;
      buffer += chunk;
      for (;;) {
        const lf = buffer.indexOf('\n', scanFrom);
        const cr = buffer.indexOf('\r', scanFrom);
        let end: number;
        let width: number;
        if (cr !== -1 && (lf === -1 || cr < lf)) {
          // A trailing `\r` may be the first half of `\r\n`: wait for the next chunk.
          if (cr === buffer.length - 1) {
            scanFrom = cr;
            break;
          }
          end = cr;
          width = buffer.charCodeAt(cr + 1) === 10 ? 2 : 1;
        } else if (lf !== -1) {
          end = lf;
          width = 1;
        } else {
          scanFrom = buffer.length;
          break;
        }
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + width);
        scanFrom = 0;
        processLine(line);
      }
      if (buffer.length > maxBuffer) {
        buffer = '';
        scanFrom = 0;
        data = [];
        throw new Error('Flux du terminal illisible (ligne trop longue).');
      }
    },
    reset() {
      buffer = '';
      scanFrom = 0;
      data = [];
      eventName = null;
    },
  };
}

/* -------------------------------------------------------------------------------------------------
   Terminal stream events (envelope `{ seq, type, at, data }` of @nuera/shared/events)
   ------------------------------------------------------------------------------------------------- */

export type TerminalStreamEvent =
  | { type: 'terminal.snapshot'; data: string; cols: number; rows: number }
  | { type: 'terminal.data'; data: string }
  | { type: 'terminal.resize'; cols: number; rows: number }
  | { type: 'terminal.exit'; exitCode: number | null; signal: number | null }
  | { type: 'heartbeat' }
  | { type: 'stream.error'; code: string; message: string }
  | { type: 'stream.reset' };

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const intOrNull = (value: unknown): number | null | undefined => (value === null ? null : isInt(value) ? value : undefined);

/**
 * Parses the `data` of one SSE message of a terminal stream. Light validation (no zod: thousands
 * of chunks per second may flow); anything off-contract — or for another terminal — gives null.
 */
export function parseTerminalStreamEvent(raw: string, terminalId?: string): TerminalStreamEvent | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object') return null;
  const { type, data } = envelope as { type?: unknown; data?: unknown };
  if (typeof type !== 'string' || !data || typeof data !== 'object') return null;
  const payload = data as Record<string, unknown>;
  const forOther = typeof payload.terminalId === 'string' && terminalId !== undefined && payload.terminalId !== terminalId;
  switch (type) {
    case 'terminal.snapshot':
      if (forOther || typeof payload.data !== 'string' || !isInt(payload.cols) || !isInt(payload.rows)) return null;
      return { type, data: payload.data, cols: payload.cols, rows: payload.rows };
    case 'terminal.data':
      if (forOther || typeof payload.data !== 'string') return null;
      return { type, data: payload.data };
    case 'terminal.resize':
      if (forOther || !isInt(payload.cols) || !isInt(payload.rows)) return null;
      return { type, cols: payload.cols, rows: payload.rows };
    case 'terminal.exit': {
      const exitCode = intOrNull(payload.exitCode);
      const signal = intOrNull(payload.signal);
      if (forOther || exitCode === undefined || signal === undefined) return null;
      return { type, exitCode, signal };
    }
    case 'heartbeat':
      return { type };
    case 'stream.error':
      return {
        type,
        code: typeof payload.code === 'string' ? payload.code : 'UNKNOWN',
        message: typeof payload.message === 'string' ? payload.message : '',
      };
    case 'stream.reset':
      return { type };
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------------------------------
   Reconnection back-off (same cadence as the global live stream, hooks/useLiveEvents.tsx)
   ------------------------------------------------------------------------------------------------- */

/** Browser cannot reach the app: 1 → 30 s (± 20 %). */
export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
/** The app answers but the runner does not (T5): every 10 s. */
export const RUNNER_DOWN_RETRY_MS = 10_000;
/** No byte (not even a heartbeat, every 15 s) for 2.5 beats ⇒ the connection is dead. */
export const STREAM_SILENCE_TIMEOUT_MS = 37_500;

export function reconnectDelay(attempt: number, options: { runnerDown?: boolean; random?: () => number } = {}): number {
  if (options.runnerDown) return RUNNER_DOWN_RETRY_MS;
  const index = Math.min(Math.max(attempt, 1) - 1, RECONNECT_BACKOFF_MS.length - 1);
  const base = RECONNECT_BACKOFF_MS[index] ?? 30_000;
  const random = options.random ?? Math.random;
  return Math.round(base * (0.8 + random() * 0.4));
}

/** HTTP status of the stream request → final error (no retry) or null (transient: retry). */
export function streamStatusError(status: number): TerminalErrorReason | null {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 409 || status === 410) return 'closed';
  if (status === 400 || status === 422) return 'invalid';
  return null;
}

/* -------------------------------------------------------------------------------------------------
   Input: ordered batches (~10 ms), one request in flight at a time
   ------------------------------------------------------------------------------------------------- */

export interface Timers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultTimers: Timers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export const INPUT_BATCH_MS = 10;
/**
 * Characters per request. The route accepts 64 Ki characters and 128 KiB of JSON: control
 * characters are escaped as `\u001b` (6 bytes), so 16 Ki characters always fit.
 */
export const INPUT_CHUNK_CHARS = 16 * 1024;

/** Keys sent alone (and at once) so that the runner sees « Interrompre » (lone Échap / Ctrl+C). */
const INTERRUPT_KEYS = new Set(['\u001b', '\u0003']);

/** Splits `data` into chunks of at most `max` UTF-16 units without cutting a surrogate pair. */
export function splitInput(data: string, max = INPUT_CHUNK_CHARS): string[] {
  if (data.length <= max) return data ? [data] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + max, data.length);
    if (end < data.length) {
      const code = data.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

export interface InputBatcherOptions {
  send: (data: string) => Promise<void>;
  /** A request failed: the pending input is dropped (never replayed late). */
  onError?: (error: unknown) => void;
  delayMs?: number;
  chunkChars?: number;
  timers?: Timers;
}

/**
 * Keystrokes from xterm `onData` → POST /api/terminals/[id]/input. Batches what is typed within
 * `delayMs`, keeps the order (one request at a time; what arrives meanwhile leaves right after),
 * sends a lone Échap / Ctrl+C on its own and immediately.
 */
export class InputBatcher {
  private queue: string[] = [];
  private pending = '';
  private timer: unknown = null;
  private sending = false;
  private disposed = false;
  private readonly delayMs: number;
  private readonly chunkChars: number;
  private readonly timers: Timers;

  constructor(private readonly options: InputBatcherOptions) {
    this.delayMs = options.delayMs ?? INPUT_BATCH_MS;
    this.chunkChars = options.chunkChars ?? INPUT_CHUNK_CHARS;
    this.timers = options.timers ?? defaultTimers;
  }

  push(data: string): void {
    if (this.disposed || !data) return;
    if (INTERRUPT_KEYS.has(data)) {
      this.cutPending();
      this.queue.push(data);
      void this.drain();
      return;
    }
    this.pending += data;
    if (this.pending.length >= this.chunkChars) {
      this.cutPending();
      void this.drain();
      return;
    }
    if (this.timer === null && !this.sending) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        this.cutPending();
        void this.drain();
      }, this.delayMs);
    }
  }

  /** Sends what is pending now (e.g. before closing). */
  flush(): Promise<void> {
    this.cutPending();
    return this.drain();
  }

  /** Nothing waiting nor in flight. */
  get idle(): boolean {
    return !this.sending && this.queue.length === 0 && this.pending === '';
  }

  /** Drops everything pending; later pushes are ignored. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.queue = [];
    this.pending = '';
  }

  private clearTimer() {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private cutPending() {
    this.clearTimer();
    if (!this.pending) return;
    this.queue.push(...splitInput(this.pending, this.chunkChars));
    this.pending = '';
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (!this.disposed) {
        if (this.queue.length === 0) this.cutPending();
        const next = this.queue.shift();
        if (next === undefined) break;
        try {
          await this.options.send(next);
        } catch (error) {
          this.queue = [];
          this.pending = '';
          this.clearTimer();
          this.options.onError?.(error);
          break;
        }
      }
    } finally {
      this.sending = false;
    }
  }
}

/* -------------------------------------------------------------------------------------------------
   Resize policy
   ------------------------------------------------------------------------------------------------- */

export function sameSize(a: TerminalSize | null | undefined, b: TerminalSize | null | undefined): boolean {
  return Boolean(a && b && a.cols === b.cols && a.rows === b.rows);
}

/** Integer size inside the contract bounds, or null when the measure is unusable (hidden pane). */
export function clampSize(size: { cols: number; rows: number } | null | undefined): TerminalSize | null {
  if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows) || size.cols <= 0 || size.rows <= 0) return null;
  const { minCols, maxCols, minRows, maxRows } = TERMINAL_SIZE_LIMITS;
  return {
    cols: Math.min(maxCols, Math.max(minCols, Math.floor(size.cols))),
    rows: Math.min(maxRows, Math.max(minRows, Math.floor(size.rows))),
  };
}

export const RESIZE_DEBOUNCE_MS = 120;

/* -------------------------------------------------------------------------------------------------
   Phone key bar
   ------------------------------------------------------------------------------------------------- */

export type TerminalKey = 'escape' | 'tab' | 'ctrl-c' | 'left' | 'up' | 'down' | 'right';

export const KEY_BAR: ReadonlyArray<{ key: TerminalKey; label: string; ariaLabel: string }> = [
  { key: 'escape', label: 'Échap', ariaLabel: 'Échap' },
  { key: 'ctrl-c', label: 'Ctrl+C', ariaLabel: 'Ctrl+C' },
  { key: 'tab', label: 'Tab', ariaLabel: 'Tabulation' },
  { key: 'left', label: '←', ariaLabel: 'Flèche gauche' },
  { key: 'up', label: '↑', ariaLabel: 'Flèche haut' },
  { key: 'down', label: '↓', ariaLabel: 'Flèche bas' },
  { key: 'right', label: '→', ariaLabel: 'Flèche droite' },
];

/** Bytes of a key bar key; arrows follow DECCKM (application cursor keys: `ESC O A`). */
export function keySequence(key: TerminalKey, options: { applicationCursor?: boolean } = {}): string {
  const csi = options.applicationCursor ? '\u001bO' : '\u001b[';
  switch (key) {
    case 'escape':
      return '\u001b';
    case 'tab':
      return '\t';
    case 'ctrl-c':
      return '\u0003';
    case 'up':
      return `${csi}A`;
    case 'down':
      return `${csi}B`;
    case 'right':
      return `${csi}C`;
    case 'left':
      return `${csi}D`;
  }
}

/* -------------------------------------------------------------------------------------------------
   Clipboard shortcuts
   ------------------------------------------------------------------------------------------------- */

export interface KeyLike {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * What a key press means for the clipboard (null = give it to the terminal).
 * - macOS: ⌘C / ⌘V are native (xterm leaves them to the browser) → null.
 * - Elsewhere: Ctrl+Shift+C / Ctrl+Insert copy; Ctrl+C copies only when text is selected
 *   (otherwise it is the Ctrl+C of the terminal); Ctrl+V, Ctrl+Shift+V, Shift+Insert paste
 *   through the browser (the `paste` event, bracketed by xterm when the program asks).
 */
export function clipboardShortcut(event: KeyLike, context: { isMac: boolean; hasSelection: boolean }): 'copy' | 'paste' | null {
  if (event.type !== 'keydown' || context.isMac || event.altKey || event.metaKey) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (event.ctrlKey && event.shiftKey && key === 'c') return 'copy';
  if (event.ctrlKey && !event.shiftKey && key === 'Insert') return context.hasSelection ? 'copy' : null;
  if (event.ctrlKey && !event.shiftKey && key === 'c') return context.hasSelection ? 'copy' : null;
  if (event.ctrlKey && key === 'v') return 'paste';
  if (event.shiftKey && !event.ctrlKey && key === 'Insert') return 'paste';
  return null;
}

/* -------------------------------------------------------------------------------------------------
   Links (web links addon, OSC 8 hyperlinks)
   ------------------------------------------------------------------------------------------------- */

/** Only absolute http(s) URLs without credentials are opened (new tab, noopener noreferrer). */
export function safeExternalUrl(uri: string): string | null {
  try {
    const url = new URL(uri.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------------------------------
   Typography: JetBrains Mono 13 / 21 (Figma W2 « Terminal brut »)
   ------------------------------------------------------------------------------------------------- */

export const DESKTOP_FONT_SIZE = 13;
/** Phone: 11 / 17 like the dark detail blocks of W2, ≈ 50 columns at 390 px. */
export const PHONE_FONT_SIZE = 11;

/** Line height (px) paired with a font size: 13 → 21, 12 → 18, 11 → 17 (Figma), else ×1.6. */
export function lineHeightFor(fontSize: number): number {
  if (fontSize === 13) return 21;
  if (fontSize === 12) return 18;
  if (fontSize === 11) return 17;
  return Math.round(fontSize * 1.6);
}

/**
 * xterm `lineHeight` multiplier giving rows of `targetPx` CSS pixels: xterm computes
 * floor(ceil(charHeight × dpr) × lineHeight) device pixels per row.
 */
export function xtermLineHeight(targetPx: number, charHeightPx: number, dpr = 1): number {
  if (!(charHeightPx > 0) || !(targetPx > 0)) return 1.2;
  const ratio = dpr > 0 ? dpr : 1;
  const deviceChar = Math.ceil(charHeightPx * ratio);
  const value = (targetPx * ratio + 0.5) / deviceChar;
  return Math.max(1, Math.round(value * 10_000) / 10_000);
}

/* -------------------------------------------------------------------------------------------------
   Colours: the dark tokens (data-tone="dark") → xterm theme
   ------------------------------------------------------------------------------------------------- */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp255 = (value: number) => Math.min(255, Math.max(0, Math.round(value)));

/** Parses what `getComputedStyle().color` returns (`rgb()`, `rgba()`, `color(srgb …)`) and `#hex`. */
export function parseCssColor(value: string | null | undefined): Rgba | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = hex.split('').map((c) => parseInt(c + c, 16));
      return { r: r!, g: g!, b: b!, a: a === undefined ? 1 : a / 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
    }
    return null;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(text);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return { r: clamp255(+rgb[1]!), g: clamp255(+rgb[2]!), b: clamp255(+rgb[3]!), a: Math.min(1, Math.max(0, alpha)) };
  }
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(text);
  if (srgb) {
    const alpha = srgb[4] === undefined ? 1 : srgb[4].endsWith('%') ? parseFloat(srgb[4]) / 100 : parseFloat(srgb[4]);
    return { r: clamp255(+srgb[1]! * 255), g: clamp255(+srgb[2]! * 255), b: clamp255(+srgb[3]! * 255), a: Math.min(1, Math.max(0, alpha)) };
  }
  return null;
}

/** Opaque colour of `color` drawn over `background`. */
export function flatten(color: Rgba, background: Rgba): Rgba {
  const a = color.a;
  return {
    r: clamp255(color.r * a + background.r * (1 - a)),
    g: clamp255(color.g * a + background.g * (1 - a)),
    b: clamp255(color.b * a + background.b * (1 - a)),
    a: 1,
  };
}

/** `color-mix(in srgb, a weight, b)`. */
export function mixColors(a: Rgba, b: Rgba, weight = 0.5): Rgba {
  return {
    r: clamp255(a.r * weight + b.r * (1 - weight)),
    g: clamp255(a.g * weight + b.g * (1 - weight)),
    b: clamp255(a.b * weight + b.b * (1 - weight)),
    a: a.a * weight + b.a * (1 - weight),
  };
}

export function withAlpha(color: Rgba, alpha: number): Rgba {
  return { ...color, a: alpha };
}

export function toHex(color: Rgba): string {
  const part = (n: number) => clamp255(n).toString(16).padStart(2, '0');
  const alpha = color.a >= 1 ? '' : part(color.a * 255);
  return `#${part(color.r)}${part(color.g)}${part(color.b)}${alpha}`;
}

/** Tokens read inside the `data-tone="dark"` scope of the terminal (tokens.css). */
export interface TerminalTokens {
  /** `--bg` (ink #233353). */
  bg: Rgba;
  /** `--text` (paper). */
  text: Rgba;
  /** `--muted` (white 62 %). */
  muted: Rgba;
  /** `--accent` (accent-on-dark #a6b9dd). */
  accent: Rgba;
  /** `--border` (white 14 %). */
  border: Rgba;
  /** `--near-black`. */
  nearBlack: Rgba;
  /** `--danger-on-dark` (= danger-pale, canvas gap 2: terminal errors). */
  danger: Rgba;
  /** `--success-on-dark`. */
  success: Rgba;
  /** `--warn-on-dark`. */
  warn: Rgba;
}

export const TERMINAL_TOKEN_VARS: Readonly<Record<keyof TerminalTokens, string>> = {
  bg: '--bg',
  text: '--text',
  muted: '--muted',
  accent: '--accent',
  border: '--border',
  nearBlack: '--near-black',
  danger: '--danger-on-dark',
  success: '--success-on-dark',
  warn: '--warn-on-dark',
};

/**
 * xterm theme from the dark tokens (Figma W2: text white, muted 62 % white, accent #a6b9dd,
 * failures in danger-pale). Translucent tokens are flattened over the background (xterm dims
 * text itself); magenta and cyan, which the design system does not name, are mixes of the accent
 * with the danger and success tokens.
 */
export function buildTerminalTheme(tokens: TerminalTokens): ITheme {
  const bg = { ...tokens.bg, a: 1 };
  const flat = (color: Rgba) => toHex(flatten(color, bg));
  const text = flat(tokens.text);
  const muted = flat(tokens.muted);
  const accent = flat(tokens.accent);
  const danger = flat(tokens.danger);
  const success = flat(tokens.success);
  const warn = flat(tokens.warn);
  const magenta = toHex(flatten(mixColors(tokens.accent, tokens.danger), bg));
  const cyan = toHex(flatten(mixColors(tokens.accent, tokens.success), bg));
  return {
    background: toHex(bg),
    foreground: text,
    cursor: accent,
    cursorAccent: toHex(bg),
    selectionBackground: toHex(withAlpha(tokens.accent, 0.35)),
    selectionInactiveBackground: toHex(withAlpha(tokens.accent, 0.2)),
    scrollbarSliderBackground: toHex(withAlpha(tokens.text, Math.max(tokens.border.a, 0.14))),
    scrollbarSliderHoverBackground: toHex(withAlpha(tokens.text, 0.24)),
    scrollbarSliderActiveBackground: toHex(withAlpha(tokens.text, 0.32)),
    overviewRulerBorder: toHex(bg),
    black: flat(tokens.nearBlack),
    red: danger,
    green: success,
    yellow: warn,
    blue: accent,
    magenta,
    cyan,
    white: text,
    brightBlack: muted,
    brightRed: danger,
    brightGreen: success,
    brightYellow: warn,
    brightBlue: accent,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: text,
  };
}

/* -------------------------------------------------------------------------------------------------
   Copy (sober French, straight apostrophes)
   ------------------------------------------------------------------------------------------------- */

export function exitText(exitCode: number | null): string {
  return exitCode === null ? 'Processus terminé' : `Processus terminé · code ${exitCode}`;
}

export function errorText(reason: TerminalErrorReason): string {
  switch (reason) {
    case 'closed':
      return 'Ce terminal est fermé.';
    case 'unauthorized':
      return 'Votre session a expiré : reconnectez-vous pour reprendre ce terminal.';
    case 'forbidden':
      return 'Accès refusé à ce terminal.';
    case 'invalid':
      return 'Terminal invalide.';
  }
}

/** Sentence announced (aria-live polite) when the state changes; null = nothing to say. */
export function stateAnnouncement(
  state: TerminalViewState,
  detail: { exitCode?: number | null; error?: TerminalErrorReason | null; wasLive?: boolean } = {},
): string | null {
  switch (state) {
    case 'connecting':
      return null;
    case 'live':
      return detail.wasLive ? 'Terminal reconnecté.' : 'Terminal connecté.';
    case 'reconnecting':
      return detail.wasLive ? 'Connexion au terminal perdue : nouvel essai automatique.' : 'Connexion au terminal impossible : nouvel essai automatique.';
    case 'exited':
      return `${exitText(detail.exitCode ?? null)}.`;
    case 'error':
      return errorText(detail.error ?? 'closed');
  }
}
