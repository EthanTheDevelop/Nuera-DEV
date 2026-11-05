import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Disk space used by a folder (worktree, primary clone), like `du -s`: allocated blocks when the
 * platform reports them (Linux, macOS), file sizes otherwise. Symbolic links are counted as
 * links, never followed (a link out of the projects root is not walked). Hard links are counted
 * once.
 *
 * The walk has a budget (entries and time): a tree too large to measure within it gives `null`
 * (unknown), never a partial number shown as a measure. Results are cached per path.
 *
 *   const usage = new DiskUsage();
 *   await usage.measure('/srv/dev/.worktrees/crm/core');   // 2_412_000_000 | null
 */

export interface DiskUsageBudget {
  /** Files and folders visited at most. */
  entries: number;
  /** Wall-clock time of one walk at most. */
  ms: number;
}

export const DEFAULT_DISK_BUDGET: DiskUsageBudget = { entries: 400_000, ms: 5_000 };
const CACHE_MS = 10 * 60_000;
const UNKNOWN_CACHE_MS = 60_000;

export interface DiskMeasure {
  bytes: number | null;
  at: number;
}

/** One walk (exported for tests): bytes, or null when the budget is spent or the root is unreadable. */
export async function walkDiskUsage(root: string, budget: DiskUsageBudget = DEFAULT_DISK_BUDGET): Promise<number | null> {
  const deadline = Date.now() + budget.ms;
  let entries = 0;
  let total = 0;
  const seen = new Set<string>();
  const add = (info: { size: number; blocks?: number; ino: number; dev: number; nlink: number }) => {
    if (info.nlink > 1) {
      const key = `${info.dev}:${info.ino}`;
      if (seen.has(key)) return;
      seen.add(key);
    }
    total += typeof info.blocks === 'number' && info.blocks > 0 ? info.blocks * 512 : info.size;
  };
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch {
    return null;
  }
  add(rootInfo);
  if (!rootInfo.isDirectory()) return total;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      // unreadable folder (permissions, removed meanwhile): skipped like `du` does
      continue;
    }
    for await (const entry of handle) {
      entries += 1;
      if (entries > budget.entries || (entries % 256 === 0 && Date.now() > deadline)) {
        await handle.close().catch(() => undefined);
        return null;
      }
      const full = path.join(dir, entry.name);
      try {
        const info = await lstat(full);
        add(info);
        if (info.isDirectory()) stack.push(full);
      } catch {
        // vanished between readdir and lstat
      }
    }
  }
  return Date.now() > deadline ? null : total;
}

export class DiskUsage {
  private readonly cache = new Map<string, DiskMeasure>();
  private readonly inflight = new Map<string, Promise<number | null>>();

  constructor(private readonly budget: DiskUsageBudget = DEFAULT_DISK_BUDGET) {}

  /** Cached measure (10 min; 1 min for an unknown size), walked again when stale. */
  async measure(root: string, options: { fresh?: boolean } = {}): Promise<number | null> {
    const cached = this.cache.get(root);
    if (!options.fresh && cached && Date.now() - cached.at < (cached.bytes === null ? UNKNOWN_CACHE_MS : CACHE_MS)) return cached.bytes;
    const running = this.inflight.get(root);
    if (running) return running;
    const run = walkDiskUsage(root, this.budget)
      .then((bytes) => {
        this.cache.set(root, { bytes, at: Date.now() });
        return bytes;
      })
      .finally(() => this.inflight.delete(root));
    this.inflight.set(root, run);
    return run;
  }

  /** A folder was removed or changed a lot (worktree removal, clone deletion). */
  forget(root: string): void {
    this.cache.delete(root);
  }
}
