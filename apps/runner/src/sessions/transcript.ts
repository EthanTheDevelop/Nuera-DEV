import { copyFile, mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
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

/**
 * Name of the `projects/` sub-folder the CLI uses for a working directory (docs: « your working
 * directory path with non-alphanumeric characters replaced by `-` … truncates the name to 200
 * characters and appends a hash of the full path »). The hash is the CLI's own: the 32-bit string
 * hash of the path, absolute value in base 36.
 */
export function claudeProjectDirName(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= 200) return name;
  let hash = 0;
  for (let i = 0; i < cwd.length; i += 1) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FoundTranscript {
  /** Real path of the conversation file. */
  path: string;
  /** Where `claude --resume <id>` looks for it: `<root>/<project dir of cwd>/<id>.jsonl` of the first root. */
  expected: string;
  /** Already at the expected place. */
  inPlace: boolean;
}

/**
 * Conversation file `<id>.jsonl` of ONE account (its `projects/` roots, never another account's):
 * the expected place for `cwd` first, then the recorded path when it lies inside those roots (a
 * config folder that moved), then every project folder of each root (the worktree was recreated
 * elsewhere, the session ran from another folder, HOME or CLAUDE_CONFIG_DIR changed). Empty files
 * (a CLI stopped before its first message) do not count. Null when nothing is found.
 */
export async function findTranscript(input: {
  conversationId: string | null;
  recordedPath: string | null;
  roots: readonly string[];
  cwd: string;
}): Promise<FoundTranscript | null> {
  const id = input.conversationId;
  if (!id || !CONVERSATION_ID.test(id) || input.roots.length === 0) return null;
  const file = `${id}.jsonl`;
  const expected = path.join(input.roots[0]!, claudeProjectDirName(input.cwd), file);
  const realRoots: string[] = [];
  for (const root of input.roots) {
    try {
      const real = await realpath(root);
      if (!realRoots.includes(real)) realRoots.push(real);
    } catch {
      // root absent (never created on this server)
    }
  }
  const usable = async (candidate: string): Promise<string | null> => {
    try {
      const real = await realpath(candidate);
      if (!realRoots.some((root) => isPathInside(root, real, PLATFORM, { allowEqual: false }))) return null;
      const info = await stat(real);
      return info.isFile() && info.size > 0 ? real : null;
    } catch {
      return null;
    }
  };
  const found = (real: string): FoundTranscript => ({ path: real, expected, inPlace: path.resolve(real) === path.resolve(expected) || real === expectedReal });
  let expectedReal: string | null = null;
  const atExpected = await usable(expected);
  if (atExpected) {
    expectedReal = atExpected;
    return found(atExpected);
  }
  if (input.recordedPath && path.basename(input.recordedPath) === file) {
    const recorded = await usable(input.recordedPath);
    if (recorded) return found(recorded);
  }
  for (const root of realRoots) {
    let dirs: string[];
    try {
      dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const candidate = await usable(path.join(root, dir, file));
      if (candidate) return found(candidate);
    }
  }
  return null;
}

/**
 * Copies a conversation file found elsewhere in the SAME account's folders to the place
 * `claude --resume <id>` reads (never moved: the original stays). Returns the new path.
 */
export async function placeTranscript(found: FoundTranscript): Promise<string> {
  if (found.inPlace) return found.path;
  await mkdir(path.dirname(found.expected), { recursive: true, mode: 0o700 });
  try {
    await copyFile(found.path, found.expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return found.expected;
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
