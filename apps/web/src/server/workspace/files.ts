import 'server-only';
import type { FileContent, TreeEntry } from '@nuera/shared/runner';
import type { RequestContext } from '@/server/tenancy/context';
import { requireWorktreeContext } from './access';

/**
 * « Fichiers » (W1 `Explorateur de fichiers`): tree and read-only preview of a worktree. Every read
 * goes through the runner (paths confined by `realpath`, `.git` never served, size cap and binary
 * detection there); the web adds its own display cap. The worktree must be one of the space, and
 * the runner asked is the one of its server.
 */

/** Text shown in the preview at most (the runner caps reads too). */
export const PREVIEW_MAX_CHARS = 256 * 1024;

/** File preview; `secret`: content withheld (see isSecretFile). */
export type WorkspaceFileContent = FileContent & { secret?: boolean };

export interface TreeView {
  path: string;
  entries: TreeEntry[];
  truncated: boolean;
}

export async function getTree(ctx: Pick<RequestContext, 'space'>, worktreeId: string, path: string): Promise<TreeView> {
  const { scope } = await requireWorktreeContext(ctx, worktreeId);
  const tree = await scope.runner.fileTree({ params: { worktreeId }, query: { path } }, { timeoutMs: 15_000 });
  // Folders first, then files, each alphabetically (the runner order is kept within a kind).
  const entries = [...tree.entries].sort((a, b) => {
    const da = a.kind === 'dir' ? 0 : 1;
    const dbb = b.kind === 'dir' ? 0 : 1;
    return da - dbb || a.name.localeCompare(b.name, 'fr');
  });
  return { path: tree.path, entries, truncated: tree.truncated };
}

/**
 * Files that usually hold secrets (`.env`, `.env.local`, private keys): their content never reaches
 * the browser preview (templates such as `.env.example` stay readable).
 */
export function isSecretFile(path: string): boolean {
  const name = (path.split('/').pop() ?? path).toLowerCase();
  if (/^\.env(\..+)?$/.test(name)) return !/\.(example|sample|template|dist|defaults?)$/.test(name);
  return /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name) || /\.(pem|key|p12|pfx)$/.test(name);
}

export async function getFile(ctx: Pick<RequestContext, 'space'>, worktreeId: string, path: string): Promise<WorkspaceFileContent> {
  const { scope } = await requireWorktreeContext(ctx, worktreeId);
  const file = await scope.runner.readFile({ params: { worktreeId }, query: { path } }, { timeoutMs: 15_000 });
  if (isSecretFile(file.path)) return { ...file, content: null, truncated: false, secret: true };
  if (file.content !== null && file.content.length > PREVIEW_MAX_CHARS) {
    return { ...file, content: file.content.slice(0, PREVIEW_MAX_CHARS), truncated: true };
  }
  return file;
}
