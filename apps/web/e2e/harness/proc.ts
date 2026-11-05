/**
 * TEST-ONLY — process helpers for the local stack (Windows first: detached children, whole-tree
 * kills with taskkill, listening ports read from netstat; POSIX fallbacks).
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const isWindows = process.platform === 'win32';

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function run(file: string, args: string[], timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number | string }).code as number | null) ?? 1 : 0;
      resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export interface DetachedSpawn {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logFile: string;
}

/** Starts a process that outlives the launcher (own process group, output appended to its log). */
export function spawnDetached(input: DetachedSpawn): number {
  mkdirSync(path.dirname(input.logFile), { recursive: true });
  const fd = openSync(input.logFile, 'a');
  try {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    if (!child.pid) throw new Error(`Impossible de lancer ${input.command} ${input.args.join(' ')}`);
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/** Kills a process and all its descendants. Never throws. */
export async function killTree(pid: number): Promise<void> {
  if (!pidAlive(pid)) return;
  if (isWindows) {
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], 60_000);
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // gone
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
}

/** `netstat -ano` → { port → pids } of LISTENING TCP sockets (IPv4 and IPv6). Exported for tests. */
export function parseNetstatListening(output: string): Map<number, Set<number>> {
  const result = new Map<number, Set<number>>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!match) continue;
    const local = match[1]!;
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    const pid = Number(match[2]);
    if (!Number.isInteger(port) || !pid) continue;
    if (!result.has(port)) result.set(port, new Set());
    result.get(port)!.add(pid);
  }
  return result;
}

/** PIDs listening on each of `ports` (empty set = free). */
export async function listeningPids(ports: number[]): Promise<Map<number, Set<number>>> {
  const wanted = new Map<number, Set<number>>(ports.map((port) => [port, new Set<number>()]));
  if (isWindows) {
    const { stdout } = await run('netstat', ['-ano', '-p', 'TCP'], 60_000);
    const { stdout: v6 } = await run('netstat', ['-ano', '-p', 'TCPv6'], 60_000);
    const all = parseNetstatListening(`${stdout}\n${v6}`);
    for (const port of ports) for (const pid of all.get(port) ?? []) wanted.get(port)!.add(pid);
    return wanted;
  }
  for (const port of ports) {
    const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], 20_000);
    for (const pid of stdout.split(/\s+/).filter(Boolean).map(Number)) wanted.get(port)!.add(pid);
  }
  return wanted;
}

/** True when something accepts TCP connections on 127.0.0.1:<port> (or ::1). */
export async function portAcceptsConnections(port: number, timeoutMs = 1500): Promise<boolean> {
  const attempt = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  return (await attempt('127.0.0.1')) || (await attempt('::1'));
}

/** Last lines of a log file (for error messages). */
export function tailFile(file: string, lines = 40): string {
  if (!existsSync(file)) return '';
  try {
    const size = statSync(file).size;
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    return buffer.toString('utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    try {
      return readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
    } catch {
      return '';
    }
  }
}

export interface WaitHttpOptions {
  timeoutMs: number;
  intervalMs?: number;
  headers?: Record<string, string>;
  /** Fails early when the process that should answer is gone. */
  pid?: number;
  logFile?: string;
  label: string;
  /** Accepts the response (default: 200). */
  accept?: (response: Response) => boolean | Promise<boolean>;
  onWait?: (elapsedMs: number) => void;
}

export async function waitForHttp(url: string, options: WaitHttpOptions): Promise<void> {
  const started = Date.now();
  let lastError = '';
  let lastNotice = started;
  for (;;) {
    try {
      const response = await fetch(url, { headers: options.headers, redirect: 'manual', signal: AbortSignal.timeout(Math.min(60_000, options.timeoutMs)) });
      const ok = options.accept ? await options.accept(response) : response.status === 200;
      await response.body?.cancel().catch(() => undefined);
      if (ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    }
    if (options.pid && !pidAlive(options.pid)) {
      throw new Error(`${options.label} s'est arrêté avant de répondre (${url}).${options.logFile ? `\n--- ${options.logFile} ---\n${tailFile(options.logFile)}` : ''}`);
    }
    const elapsed = Date.now() - started;
    if (elapsed > options.timeoutMs) {
      throw new Error(`${options.label} ne répond pas après ${Math.round(elapsed / 1000)} s (${url} : ${lastError}).${options.logFile ? `\n--- ${options.logFile} ---\n${tailFile(options.logFile)}` : ''}`);
    }
    if (options.onWait && Date.now() - lastNotice > 30_000) {
      lastNotice = Date.now();
      options.onWait(elapsed);
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1000));
  }
}

/** Image name of a process (`node.exe`), null when it does not exist. */
export async function processImage(pid: number): Promise<string | null> {
  if (!pidAlive(pid)) return null;
  if (!isWindows) {
    const { stdout } = await run('ps', ['-p', String(pid), '-o', 'comm='], 10_000);
    return stdout.trim() || null;
  }
  const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 30_000);
  const match = /^"([^"]+)"/m.exec(stdout.trim());
  return match ? match[1]! : null;
}
