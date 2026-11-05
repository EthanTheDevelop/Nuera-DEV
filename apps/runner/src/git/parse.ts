import type { ChangedFile, DiffHunk, GitStatus, StatusFile } from '@nuera/shared/runner';

// ---------------------------------------------------------------------------------------------
// git status --porcelain=v2 --branch -z
// ---------------------------------------------------------------------------------------------

export function parseStatusV2(output: string): GitStatus {
  const status: GitStatus = {
    branch: null,
    detached: false,
    headSha: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    clean: true,
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  };
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (!entry) continue;
    if (entry.startsWith('# ')) {
      const [, key, ...rest] = entry.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') status.headSha = value === '(initial)' ? null : value;
      else if (key === 'branch.head') {
        if (value === '(detached)') status.detached = true;
        else status.branch = value;
      } else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = entry[0];
    if (type === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parts = entry.split(' ');
      const xy = parts[1] ?? '..';
      const p = parts.slice(8).join(' ');
      status.files.push(makeFile(p, null, 'changed', xy));
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const parts = entry.split(' ');
      const xy = parts[1] ?? '..';
      const p = parts.slice(9).join(' ');
      const orig = fields[i + 1] ?? null;
      i += 1;
      status.files.push(makeFile(p, orig, 'renamed', xy));
    } else if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = entry.split(' ');
      const xy = parts[1] ?? 'UU';
      const p = parts.slice(10).join(' ');
      status.files.push(makeFile(p, null, 'unmerged', xy));
    } else if (type === '?') {
      status.files.push({ path: entry.slice(2), oldPath: null, kind: 'untracked', index: '?', worktree: '?', staged: false, unstaged: true, conflicted: false });
    } else if (type === '!') {
      status.files.push({ path: entry.slice(2), oldPath: null, kind: 'ignored', index: '!', worktree: '!', staged: false, unstaged: false, conflicted: false });
    }
  }
  for (const file of status.files) {
    if (file.kind === 'ignored') continue;
    if (file.conflicted) status.counts.conflicted += 1;
    else if (file.kind === 'untracked') status.counts.untracked += 1;
    else {
      if (file.staged) status.counts.staged += 1;
      if (file.unstaged) status.counts.unstaged += 1;
    }
  }
  status.clean = status.files.every((f) => f.kind === 'ignored');
  return status;
}

function makeFile(path: string, oldPath: string | null, kind: StatusFile['kind'], xy: string): StatusFile {
  const index = xy[0] ?? '.';
  const worktree = xy[1] ?? '.';
  const conflicted = kind === 'unmerged';
  return {
    path,
    oldPath,
    kind,
    index,
    worktree,
    staged: !conflicted && index !== '.',
    unstaged: !conflicted && worktree !== '.',
    conflicted,
  };
}

/** M/A/D/R/C/T/U letter shown in the change list (index letter first, then worktree letter). */
export function changeLetter(file: StatusFile): ChangedFile['status'] {
  if (file.conflicted) return 'U';
  if (file.kind === 'untracked') return 'A';
  const letter = file.index !== '.' ? file.index : file.worktree;
  if (letter === 'M' || letter === 'A' || letter === 'D' || letter === 'R' || letter === 'C' || letter === 'T') return letter;
  return 'M';
}

// ---------------------------------------------------------------------------------------------
// git diff --numstat -z (with -M)
// ---------------------------------------------------------------------------------------------

export interface NumstatEntry {
  path: string;
  oldPath: string | null;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export function parseNumstatZ(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(field);
    if (!m) continue;
    const binary = m[1] === '-' && m[2] === '-';
    const insertions = binary ? 0 : Number(m[1]);
    const deletions = binary ? 0 : Number(m[2]);
    if (m[3] === '') {
      // rename: "<a>\t<d>\t\0<old>\0<new>\0"
      const oldPath = fields[i + 1] ?? '';
      const newPath = fields[i + 2] ?? '';
      i += 2;
      entries.push({ path: newPath, oldPath, insertions, deletions, binary });
    } else {
      entries.push({ path: m[3] ?? '', oldPath: null, insertions, deletions, binary });
    }
  }
  return entries;
}

/** git diff --name-status -z -M → letters (R100 → R). */
export function parseNameStatusZ(output: string): Array<{ path: string; oldPath: string | null; letter: string }> {
  const out: Array<{ path: string; oldPath: string | null; letter: string }> = [];
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const code = fields[i];
    if (!code) continue;
    const letter = code[0] ?? 'M';
    if (letter === 'R' || letter === 'C') {
      const oldPath = fields[i + 1] ?? '';
      const newPath = fields[i + 2] ?? '';
      i += 2;
      out.push({ path: newPath, oldPath, letter });
    } else {
      const p = fields[i + 1] ?? '';
      i += 1;
      out.push({ path: p, oldPath: null, letter });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Unified diff → hunks
// ---------------------------------------------------------------------------------------------

export interface ParsedDiff {
  binary: boolean;
  hunks: DiffHunk[];
  insertions: number;
  deletions: number;
  truncated: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Parses the output of `git diff` for ONE file. Lines beyond `maxLines` are dropped and
 * `truncated` is set (the UI then offers the raw terminal / a narrower view).
 */
export function parseUnifiedDiff(output: string, options: { maxLines?: number } = {}): ParsedDiff {
  const maxLines = options.maxLines ?? 20_000;
  const result: ParsedDiff = { binary: false, hunks: [], insertions: 0, deletions: 0, truncated: false };
  const lines = output.split('\n');
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let count = 0;
  for (const line of lines) {
    if (line === '') continue; // split artefact: real context lines always start with ' '
    if (/^Binary files .* differ\r?$/.test(line) || line.startsWith('GIT binary patch')) {
      result.binary = true;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunk = {
        header: line,
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        context: header[5] ?? '',
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      result.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // file headers (diff --git, index, ---, +++)
    if (line.startsWith('\\')) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    if (count >= maxLines) {
      result.truncated = true;
      continue;
    }
    const sign = line[0];
    const text = line.slice(1).replace(/\r$/, '');
    if (sign === '+') {
      hunk.lines.push({ type: 'add', oldNumber: null, newNumber: newNo, text });
      newNo += 1;
      result.insertions += 1;
      count += 1;
    } else if (sign === '-') {
      hunk.lines.push({ type: 'del', oldNumber: oldNo, newNumber: null, text });
      oldNo += 1;
      result.deletions += 1;
      count += 1;
    } else if (sign === ' ') {
      hunk.lines.push({ type: 'context', oldNumber: oldNo, newNumber: newNo, text });
      oldNo += 1;
      newNo += 1;
      count += 1;
    }
  }
  return result;
}

/** Diff of a new (untracked) text file, built locally: one hunk of additions. */
export function additionDiff(content: string, maxLines = 20_000): ParsedDiff {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
  if (normalized.length === 0) return { binary: false, hunks: [], insertions: 0, deletions: 0, truncated: false };
  const kept = lines.slice(0, maxLines);
  const hunk: DiffHunk = {
    header: `@@ -0,0 +1,${lines.length} @@`,
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    context: '',
    lines: kept.map((text, index) => ({ type: 'add' as const, oldNumber: null, newNumber: index + 1, text })),
  };
  if (!normalized.endsWith('\n') && kept.length === lines.length) {
    const last = hunk.lines[hunk.lines.length - 1];
    if (last) last.noNewline = true;
  }
  return { binary: false, hunks: [hunk], insertions: lines.length, deletions: 0, truncated: kept.length < lines.length };
}

// ---------------------------------------------------------------------------------------------
// git worktree list --porcelain
// ---------------------------------------------------------------------------------------------

export interface WorktreeListEntry {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export function parseWorktreeList(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
    else if (line.startsWith('locked')) current.locked = true;
    else if (line.startsWith('prunable')) current.prunable = true;
  }
  if (current) entries.push(current);
  return entries;
}

// ---------------------------------------------------------------------------------------------
// git push --porcelain
// ---------------------------------------------------------------------------------------------

export interface PushRefResult {
  flag: string;
  from: string;
  to: string;
  summary: string;
}

export function parsePushPorcelain(output: string): PushRefResult[] {
  const results: PushRefResult[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^([ +\-*=!])\t([^:\t]*):([^\t]*)\t(.*)$/.exec(line);
    if (m) results.push({ flag: m[1]!, from: m[2]!, to: m[3]!, summary: m[4]! });
  }
  return results;
}

/** `[ahead 2, behind 1]`, `ahead 3`, `gone`… from `%(upstream:track,nobracket)`. */
export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: /gone/.test(track) };
}
