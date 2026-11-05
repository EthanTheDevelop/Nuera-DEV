import { lstat, open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { extName, baseName, relativeInside } from '@nuera/shared/paths';
import type { FileContent, TreeEntry } from '@nuera/shared/runner';
import { RunnerError } from '../errors';
import type { Git } from '../git/git';
import type { GitService } from '../git/service';
import { PLATFORM, type PathGuard } from '../safety/paths';

const isGitDirPath = (rel: string) => rel.split('/')[0]!.toLowerCase() === '.git';

/** `.git` is never served: neither by name (any case) nor through a symlink that resolves into it. */
function assertNotGitDir(root: string, requested: string, resolved: string): void {
  const real = relativeInside(root, resolved, PLATFORM);
  if (isGitDirPath(requested) || (real !== null && isGitDirPath(real))) {
    throw new RunnerError('FORBIDDEN', "Le dossier .git n'est pas consultable.");
  }
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;
const LINE_COUNT_NAMES = new Set(['claude.md', 'agents.md', 'readme.md']);

const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  md: 'markdown',
  mdx: 'mdx',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  xml: 'xml',
  svg: 'xml',
  graphql: 'graphql',
  gql: 'graphql',
  prisma: 'prisma',
  dockerfile: 'dockerfile',
  env: 'dotenv',
  txt: 'text',
};

export function languageFor(filePath: string): string | null {
  const name = baseName(filePath).toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  if (name.startsWith('.env')) return 'dotenv';
  return LANGUAGES[extName(filePath)] ?? null;
}

function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** Read-only file access inside a worktree (lazy tree, capped reads, binary detection). */
export class FileService {
  constructor(private readonly deps: { paths: PathGuard; git: Git; gitService: GitService }) {}

  async tree(worktreeId: string, relativePath: string): Promise<{ path: string; entries: TreeEntry[]; truncated: boolean }> {
    const { cwd } = await this.deps.gitService.resolveWorktree(worktreeId);
    const rel = relativePath ? this.deps.paths.relativeForGit(relativePath) : '';
    if (rel && isGitDirPath(rel)) throw new RunnerError('FORBIDDEN', "Le dossier .git n'est pas consultable.");
    const dir = await this.deps.paths.resolveInWorktree(cwd, rel);
    if (rel) assertNotGitDir(cwd, rel, dir);
    const info = await stat(dir);
    if (!info.isDirectory()) throw new RunnerError('VALIDATION', "Ce chemin n'est pas un dossier.");

    const dirents = await readdir(dir, { withFileTypes: true });
    const visible = dirents.filter((d) => !(rel === '' && d.name.toLowerCase() === '.git'));
    const truncated = visible.length > MAX_ENTRIES;
    const kept = visible.slice(0, MAX_ENTRIES);
    const entries: TreeEntry[] = [];
    for (const d of kept) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const abs = path.join(dir, d.name);
      let kind: TreeEntry['kind'] = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'symlink' : 'other';
      let size: number | null = null;
      let lines: number | null = null;
      try {
        const st = await lstat(abs);
        if (kind === 'file') size = st.size;
        if (kind === 'symlink') {
          // A symlink is shown, never followed out of the worktree.
          try {
            const target = await this.deps.paths.resolveInWorktree(cwd, childRel);
            const t = await stat(target);
            kind = t.isDirectory() ? 'dir' : 'file';
            size = t.isFile() ? t.size : null;
          } catch {
            kind = 'symlink';
          }
        }
        if (kind === 'file' && size !== null && size <= MAX_FILE_BYTES && LINE_COUNT_NAMES.has(d.name.toLowerCase())) {
          lines = countLines(await this.readText(abs, size));
        }
      } catch {
        // unreadable entry: listed without details
      }
      entries.push({ name: d.name, path: childRel, kind, size, ignored: false, lines });
    }

    // Ignored files (one batched `git check-ignore --stdin`).
    if (entries.length > 0) {
      const input = entries.map((e) => (e.kind === 'dir' ? `${e.path}/` : e.path)).join('\0') + '\0';
      const result = await this.deps.git.run(['check-ignore', '-z', '--stdin'], { cwd, input, allowFailure: true, timeoutMs: 20_000 });
      if (result.exitCode === 0 || result.exitCode === 1) {
        const ignored = new Set(result.stdout.split('\0').filter(Boolean).map((p) => p.replace(/\/$/, '')));
        for (const e of entries) if (ignored.has(e.path)) e.ignored = true;
      }
    }
    entries.sort((a, b) => (a.kind === 'dir') === (b.kind === 'dir') ? a.name.localeCompare(b.name, 'fr') : a.kind === 'dir' ? -1 : 1);
    return { path: rel, entries, truncated };
  }

  private async readText(abs: string, size: number): Promise<string> {
    const handle = await open(abs, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async read(worktreeId: string, relativePath: string): Promise<FileContent> {
    const { cwd } = await this.deps.gitService.resolveWorktree(worktreeId);
    const rel = this.deps.paths.relativeForGit(relativePath);
    if (isGitDirPath(rel)) throw new RunnerError('FORBIDDEN', "Le dossier .git n'est pas consultable.");
    const abs = await this.deps.paths.resolveInWorktree(cwd, rel);
    assertNotGitDir(cwd, rel, abs);
    const info = await stat(abs);
    if (!info.isFile()) throw new RunnerError('VALIDATION', "Ce chemin n'est pas un fichier.");
    const handle = await open(abs, 'r');
    try {
      const length = Math.min(info.size, MAX_FILE_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      const data = buffer.subarray(0, bytesRead);
      const binary = data.subarray(0, 8000).includes(0);
      const truncated = info.size > MAX_FILE_BYTES;
      const content = binary ? null : data.toString('utf8');
      return {
        path: rel,
        size: info.size,
        binary,
        truncated,
        content,
        language: binary ? null : languageFor(rel),
        lines: content === null || truncated ? null : countLines(content),
        modifiedAt: info.mtime.toISOString(),
      };
    } finally {
      await handle.close();
    }
  }
}
