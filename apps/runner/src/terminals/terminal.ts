import { randomBytes } from 'node:crypto';
import * as ptyNs from '@lydell/node-pty';
import * as headlessNs from '@xterm/headless';
import * as serializeNs from '@xterm/addon-serialize';
import type { IPty } from '@lydell/node-pty';
import type { TerminalDto, TerminalKind } from '@nuera/shared/runner';

// CommonJS packages: namespace (esbuild) or `default` (Node ESM) depending on the loader.
type PtyModule = typeof import('@lydell/node-pty');
type HeadlessModule = typeof import('@xterm/headless');
type SerializeModule = typeof import('@xterm/addon-serialize');
const pick = <T>(ns: unknown, key: string): T =>
  ((ns as Record<string, unknown>)[key] ?? ((ns as { default?: Record<string, unknown> }).default ?? {})[key]) as T;
const spawnPty = pick<PtyModule['spawn']>(ptyNs, 'spawn');
const HeadlessTerminal = pick<HeadlessModule['Terminal']>(headlessNs, 'Terminal');
const SerializeAddon = pick<SerializeModule['SerializeAddon']>(serializeNs, 'SerializeAddon');

type Mirror = InstanceType<HeadlessModule['Terminal']>;
type Serializer = InstanceType<SerializeModule['SerializeAddon']>;

export interface TerminalSpawnOptions {
  kind: TerminalKind;
  title: string;
  file: string;
  /** On Windows a string is passed verbatim to CreateProcess (platform shell of runs). */
  args: string[] | string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  worktreeId?: string | null;
  sessionId?: string | null;
  /** Account that opened the terminal (`actorUserId` of the request); null when the runner opened it. */
  ownerUserId?: string | null;
  /** Output never persisted nor logged; scrollback dropped on close (login terminals). */
  private?: boolean;
  scrollback?: number;
  /** Kill after this long without subscriber (null = never). */
  idleTimeoutMs?: number | null;
}

export type TerminalFrame =
  | { type: 'terminal.snapshot'; data: { terminalId: string; data: string; cols: number; rows: number } }
  | { type: 'terminal.data'; data: { terminalId: string; data: string } }
  | { type: 'terminal.resize'; data: { terminalId: string; cols: number; rows: number } }
  | { type: 'terminal.exit'; data: { terminalId: string; exitCode: number | null; signal: number | null } };

type Subscriber = { send: (frame: TerminalFrame) => void; live: boolean };

const RECENT_CHUNKS = 1024;

/**
 * One PTY + its `@xterm/headless` mirror. Every new subscriber receives a serialized snapshot
 * of the mirror (screen + scrollback) then the live chunks, without gap nor duplicate.
 */
export class Terminal {
  readonly id: string;
  readonly kind: TerminalKind;
  readonly title: string;
  readonly cwd: string;
  readonly worktreeId: string | null;
  readonly sessionId: string | null;
  readonly ownerUserId: string | null;
  readonly isPrivate: boolean;
  readonly idleTimeoutMs: number | null;
  readonly createdAt = new Date();
  lastActivityAt = new Date();
  lastSubscriberAt = Date.now();
  cols: number;
  rows: number;
  alive = true;
  exitCode: number | null = null;
  exitSignal: number | null = null;
  pid: number | null = null;

  private readonly pty: IPty;
  private mirror: Mirror | null;
  private serializer: Serializer | null;
  private readonly subscribers = new Set<Subscriber>();
  private readonly outputListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(code: number | null, signal: number | null) => void>();
  private chunkSeq = 0;
  private recent: Array<{ seq: number; data: string }> = [];
  private lastResizeClient: string | null = null;

  constructor(options: TerminalSpawnOptions) {
    this.id = randomBytes(12).toString('base64url');
    this.kind = options.kind;
    this.title = options.title;
    this.cwd = options.cwd;
    this.worktreeId = options.worktreeId ?? null;
    this.sessionId = options.sessionId ?? null;
    this.ownerUserId = options.ownerUserId ?? null;
    this.isPrivate = options.private ?? false;
    this.idleTimeoutMs = options.idleTimeoutMs ?? null;
    this.cols = options.cols;
    this.rows = options.rows;

    this.mirror = new HeadlessTerminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback ?? 5000,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.mirror.loadAddon(this.serializer as unknown as Parameters<Mirror['loadAddon']>[0]);

    this.pty = spawnPty(options.file, options.args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
    });
    this.pid = this.pty.pid || null;

    this.pty.onData((data) => {
      if (!this.pid && this.pty.pid) this.pid = this.pty.pid;
      this.lastActivityAt = new Date();
      this.chunkSeq += 1;
      const seq = this.chunkSeq;
      this.recent.push({ seq, data });
      if (this.recent.length > RECENT_CHUNKS) this.recent.splice(0, this.recent.length - RECENT_CHUNKS);
      this.mirror?.write(data);
      for (const sub of this.subscribers) if (sub.live) sub.send({ type: 'terminal.data', data: { terminalId: this.id, data } });
      for (const listener of this.outputListeners) {
        try {
          listener(data);
        } catch {
          // listeners never break the PTY
        }
      }
    });
    this.pty.onExit(({ exitCode, signal }) => {
      this.alive = false;
      this.exitCode = typeof exitCode === 'number' ? exitCode : null;
      this.exitSignal = typeof signal === 'number' && signal > 0 ? signal : null;
      if (process.platform === 'win32') {
        // Frees the ConPTY worker thread (docs/research/stack.md §9.2-1).
        try {
          this.pty.kill();
        } catch {
          // already gone
        }
      }
      for (const sub of this.subscribers) sub.send({ type: 'terminal.exit', data: { terminalId: this.id, exitCode: this.exitCode, signal: this.exitSignal } });
      for (const listener of this.exitListeners) {
        try {
          listener(this.exitCode, this.exitSignal);
        } catch {
          // ignore
        }
      }
    });
  }

  /** Subscribes a client: snapshot first, then live chunks. Returns the unsubscribe function. */
  subscribe(send: (frame: TerminalFrame) => void): () => void {
    const sub: Subscriber = { send, live: false };
    this.subscribers.add(sub);
    this.lastSubscriberAt = Date.now();
    const target = this.chunkSeq;
    const deliver = () => {
      if (!this.subscribers.has(sub)) return;
      const data = this.serializer ? this.serializer.serialize({ scrollback: this.isPrivate ? 500 : undefined }) : '';
      send({ type: 'terminal.snapshot', data: { terminalId: this.id, data, cols: this.cols, rows: this.rows } });
      for (const chunk of this.recent) {
        if (chunk.seq > target) send({ type: 'terminal.data', data: { terminalId: this.id, data: chunk.data } });
      }
      sub.live = true;
      if (!this.alive) send({ type: 'terminal.exit', data: { terminalId: this.id, exitCode: this.exitCode, signal: this.exitSignal } });
    };
    if (this.mirror) this.mirror.write('', deliver);
    else deliver();
    return () => {
      this.subscribers.delete(sub);
      this.lastSubscriberAt = Date.now();
    };
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Internal consumers (session readiness, run parsers). Never used for logging. */
  onOutput(listener: (data: string) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onExit(listener: (code: number | null, signal: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  write(data: string): void {
    if (!this.alive) return;
    this.lastActivityAt = new Date();
    this.pty.write(data);
  }

  /** Last client that resizes wins. */
  resize(cols: number, rows: number, clientId?: string): void {
    if (!this.alive) return;
    if (clientId) this.lastResizeClient = clientId;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.pty.resize(cols, rows);
    } catch {
      // process exiting
    }
    this.mirror?.resize(cols, rows);
    for (const sub of this.subscribers) if (sub.live) sub.send({ type: 'terminal.resize', data: { terminalId: this.id, cols, rows } });
  }

  get resizeOwner(): string | null {
    return this.lastResizeClient;
  }

  /** Raw screen text of the mirror (tests, readiness heuristics). Not for logs. */
  screenText(): string {
    const mirror = this.mirror;
    if (!mirror) return '';
    const buffer = mirror.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i += 1) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  }

  /**
   * Visible rows of the mirror only (no scrollback): what the CLI shows right now (screen
   * detection of the session manager). Not for logs.
   */
  viewportText(): string {
    const mirror = this.mirror;
    if (!mirror) return '';
    const buffer = mirror.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < mirror.rows; i += 1) lines.push(buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? '');
    return lines.join('\n');
  }

  /** Resolves once the mirror has parsed every chunk received so far (its writes are asynchronous). */
  flushed(): Promise<void> {
    const mirror = this.mirror;
    if (!mirror) return Promise.resolve();
    return new Promise((resolve) => mirror.write('', resolve));
  }

  kill(signal?: string): void {
    if (!this.alive) return;
    try {
      if (process.platform === 'win32') this.pty.kill();
      else this.pty.kill(signal ?? 'SIGHUP');
    } catch {
      // already gone
    }
  }

  /** Releases the mirror; private terminals also drop every buffered byte. */
  dispose(): void {
    this.kill();
    for (const sub of this.subscribers) {
      if (this.alive) sub.send({ type: 'terminal.exit', data: { terminalId: this.id, exitCode: null, signal: null } });
    }
    this.subscribers.clear();
    this.outputListeners.clear();
    this.recent = [];
    this.serializer?.dispose();
    this.mirror?.dispose();
    this.serializer = null;
    this.mirror = null;
  }

  toDto(): TerminalDto {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      cwd: this.isPrivate ? null : this.cwd,
      worktreeId: this.worktreeId,
      sessionId: this.sessionId,
      ownerUserId: this.ownerUserId,
      cols: this.cols,
      rows: this.rows,
      alive: this.alive,
      exitCode: this.exitCode,
      private: this.isPrivate,
      subscribers: this.subscribers.size,
      createdAt: this.createdAt.toISOString(),
      lastActivityAt: this.lastActivityAt.toISOString(),
    };
  }
}
