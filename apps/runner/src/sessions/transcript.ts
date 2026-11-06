import { open, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isPathInside } from '@nuera/shared/paths';
import { PLATFORM } from '../safety/paths';

/**
 * Tolerant reader of the session journal (`transcript_path` from the SessionStart hook).
 * The JSONL format is internal to Claude Code and changes between versions: only assistant text
 * blocks of the main conversation are extracted; every unknown shape is ignored. Nothing is ever
 * invented — if parsing fails, the Terminal view stays the reference.
 */

export interface TranscriptText {
  key: string;
  text: string;
  at: string;
  /**
   * Written by the CLI itself, not by the model (`isApiErrorMessage`, model `<synthetic>`): the
   * usage-limit message, an API error. Only such a block may stand for a usage-limit stop.
   */
  cliMessage?: boolean;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `<config dir>/projects` — the only place a transcript may live. The config dir is the one given to
 * every `claude` process of the runner (NUERA_CLAUDE_CONFIG_DIR), else the runner's own
 * CLAUDE_CONFIG_DIR, else `~/.claude`.
 */
export function transcriptsRoot(configDir: string | null = null, env: Record<string, string | undefined> = process.env): string {
  return path.join(configDir?.trim() || env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'), 'projects');
}

/** Validates a transcript path reported by a hook (never a credentials file, never outside projects/). */
export async function validateTranscriptPath(candidate: unknown, root = transcriptsRoot()): Promise<string | null> {
  if (typeof candidate !== 'string' || !candidate.endsWith('.jsonl') || candidate.includes('\0')) return null;
  if (path.basename(candidate).startsWith('.')) return null;
  try {
    const rootReal = await realpath(root);
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      // The CLI writes the file asynchronously: validate the parent directory.
      real = path.join(await realpath(path.dirname(candidate)), path.basename(candidate));
    }
    return isPathInside(rootReal, real, PLATFORM, { allowEqual: false }) ? real : null;
  } catch {
    return null;
  }
}

/** Assistant text blocks of one JSONL line (main conversation only). */
export function extractAssistantTexts(line: string): TranscriptText[] {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObj(entry) || entry.type !== 'assistant' || entry.isSidechain === true) return [];
  const message = entry.message;
  if (!isObj(message) || !Array.isArray(message.content)) return [];
  const id = typeof entry.uuid === 'string' ? entry.uuid : typeof message.id === 'string' ? message.id : null;
  if (!id) return [];
  const at = typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString();
  const out: TranscriptText[] = [];
  const cliMessage = entry.isApiErrorMessage === true || message.model === '<synthetic>';
  message.content.forEach((block, index) => {
    if (isObj(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      out.push({ key: `assistant:${id}:${index}`, text: block.text.trim(), at, ...(cliMessage ? { cliMessage: true } : {}) });
    }
  });
  return out;
}

export class TranscriptTailer {
  private offset = 0;
  private partial = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly file: string,
    private readonly onText: (text: TranscriptText) => Promise<void> | void,
    options: {
      fromEnd?: boolean;
      /**
       * Runs the periodic reads under the caller's lock (the session queue): `onText` then never
       * races with hook processing, which calls {@link drain} while already holding that lock.
       */
      runExclusive?: (task: () => Promise<void>) => Promise<unknown>;
    } = {},
  ) {
    this.fromEnd = options.fromEnd ?? false;
    this.runExclusive = options.runExclusive ?? ((task) => task());
  }

  private readonly fromEnd: boolean;
  private readonly runExclusive: (task: () => Promise<void>) => Promise<unknown>;
  private initialised = false;
  /** A periodic read is waiting for (or holding) the lock: skip ticks rather than pile them up. */
  private ticking = false;

  start(intervalMs = 750): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.timer || this.ticking) return;
      this.ticking = true;
      void this.runExclusive(() => this.drain())
        .catch(() => undefined)
        .finally(() => {
          this.ticking = false;
        });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads everything appended since the last call (serialised). */
  drain(): Promise<void> {
    this.chain = this.chain.then(() => this.readNew()).catch(() => undefined);
    return this.chain;
  }

  private async readNew(): Promise<void> {
    {
      let size: number;
      try {
        size = (await stat(this.file)).size;
      } catch {
        return;
      }
      if (!this.initialised) {
        this.initialised = true;
        if (this.fromEnd) {
          this.offset = size;
          return;
        }
      }
      if (size < this.offset) {
        // Rewritten file: start over (dedup by key protects the thread).
        this.offset = 0;
        this.partial = '';
      }
      if (size === this.offset) return;
      const handle = await open(this.file, 'r');
      try {
        const length = Math.min(size - this.offset, 8 * 1024 * 1024);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        this.offset += bytesRead;
        const text = this.partial + buffer.subarray(0, bytesRead).toString('utf8');
        const lines = text.split('\n');
        this.partial = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          for (const item of extractAssistantTexts(line)) await this.onText(item);
        }
      } finally {
        await handle.close();
      }
    }
  }
}
