import 'server-only';
import type { FileContent, TreeEntry } from '@nuera/shared/runner';
import { runner } from '@/server/runner/client';
import { requireWorktreeContext } from './access';

/**
 * « Fichiers » (W1 `Explorateur de fichiers`): tree and read-only preview of a worktree. Every read
 * goes through the runner (paths confined by `realpath`, `.git` never served, size cap and binary
 * detection there); the web adds its own display cap.
 */

/** Text shown in the preview at most (the runner caps reads too). */
export const PREVIEW_MAX_CHARS = 256 * 1024;

export interface TreeView {
  path: string;
  entries: TreeEntry[];
  truncated: boolean;
}

export async function getTree(worktreeId: string, path: string): Promise<TreeView> {
  await requireWorktreeContext(worktreeId);
  const tree = await runner.fileTree({ params: { worktreeId }, query: { path } }, { timeoutMs: 15_000 });
  // Folders first, then files, each alphabetically (the runner order is kept within a kind).
  const entries = [...tree.entries].sort((a, b) => {
    const da = a.kind === 'dir' ? 0 : 1;
    const dbb = b.kind === 'dir' ? 0 : 1;
    return da - dbb || a.name.localeCompare(b.name, 'fr');
  });
  return { path: tree.path, entries, truncated: tree.truncated };
}

export async function getFile(worktreeId: string, path: string): Promise<FileContent> {
  await requireWorktreeContext(worktreeId);
  const file = await runner.readFile({ params: { worktreeId }, query: { path } }, { timeoutMs: 15_000 });
  if (file.content !== null && file.content.length > PREVIEW_MAX_CHARS) {
    return { ...file, content: file.content.slice(0, PREVIEW_MAX_CHARS), truncated: true };
  }
  return file;
}
