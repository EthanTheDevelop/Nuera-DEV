import { spawn, type ChildProcess } from 'node:child_process';
import { buildChildEnv } from './env';

/**
 * The only way the runner starts non-PTY processes: `spawn(file, args)` with an argument array and
 * `shell: false` — never a shell (CLAUDE.md rule 4; the single documented exception is the
 * project's own commands in runs/manager.ts). Output is capped, the process is killed on timeout
 * or abort, and the environment is sanitised unless the caller passes its own (already sanitised).
 */

export interface ExecOptions {
  cwd?: string;
  /** Complete environment (use buildChildEnv). Default: sanitised process.env. */
  env?: Record<string, string>;
  /** Kill after this delay (default 60 s). */
  timeoutMs?: number;
  /** Max bytes kept per stream (default 8 MiB); the rest is dropped and `truncated` is set. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Written to stdin then closed. stdin is otherwise closed immediately (never inherited). */
  input?: string;
  /** Called with every stdout/stderr chunk (UTF-8 text). */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Windows only: pass arguments verbatim (platform shell of runs/shell.ts). */
  windowsVerbatimArguments?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
  /** spawn error (ENOENT…) */
  spawnError: NodeJS.ErrnoException | null;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      // taskkill /T kills the whole tree; spawn it detached from our own console.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    } else {
      child.kill(signal);
    }
  } catch {
    // already gone
  }
}

export function execCommand(file: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  return new Promise<ExecResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, [...args], {
        cwd: options.cwd,
        env: options.env ?? buildChildEnv(),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: Date.now() - started,
        spawnError: error as NodeJS.ErrnoException,
      });
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let settled = false;

    const collect = (target: Buffer[], size: number, chunk: Buffer): number => {
      if (size >= maxBytes) {
        truncated = true;
        return size;
      }
      const room = maxBytes - size;
      if (chunk.length > room) {
        target.push(chunk.subarray(0, room));
        truncated = true;
        return maxBytes;
      }
      target.push(chunk);
      return size + chunk.length;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes = collect(out, outBytes, chunk);
      options.onStdout?.(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errBytes = collect(err, errBytes, chunk);
      options.onStderr?.(chunk.toString('utf8'));
    });
    child.stdin?.on('error', () => undefined);
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, 'SIGKILL');
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      killProcessTree(child, 'SIGTERM');
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode,
        signal,
        timedOut,
        aborted,
        truncated,
        durationMs: Date.now() - started,
        spawnError,
      });
    };
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = error;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** True when the command could be started and exited with code 0. */
export function succeeded(result: ExecResult): boolean {
  return result.spawnError === null && !result.timedOut && !result.aborted && result.exitCode === 0;
}
