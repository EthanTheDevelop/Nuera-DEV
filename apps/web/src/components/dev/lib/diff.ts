/**
 * Unified diff model used by `DiffView` / `ChangedFileRow`, plus a tolerant parser of `git diff`
 * output (multi-file, new / deleted / renamed / binary files, quoted paths, `\ No newline`) and the
 * pairing used by the side-by-side review (W4).
 *
 * Pure module: safe on the server and in the browser.
 */
import type { ChangeStatus } from './git';

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  /** Line number before the change (null for additions). */
  oldNumber: number | null;
  /** Line number after the change (null for deletions). */
  newNumber: number | null;
  /** Line content without the +/−/space marker. */
  text: string;
  /** `\ No newline at end of file` followed this line. */
  noNewlineAtEnd?: boolean;
}

export interface DiffHunk {
  /** `@@ -12,6 +12,8 @@ export function PipelineBoard()` */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second `@@` (function context), may be empty. */
  section: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Path after the change (before it for deleted files). */
  path: string;
  /** Previous path for renames, else null. */
  oldPath: string | null;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Decodes a C-style quoted git path (`"src/caf\303\251.ts"`). Returns the input when unquoted. */
export function unquoteGitPath(raw: string): string {
  const s = raw.trim();
  if (!(s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  const pushText = (text: string) => {
    for (const b of new TextEncoder().encode(text)) bytes.push(b);
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      pushText(ch);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0];
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
      continue;
    }
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' };
    pushText(map[next] ?? next);
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripPrefix(path: string, prefix: 'a/' | 'b/'): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Path of a `---` / `+++` line (`--- a/src/x.ts`, `+++ /dev/null`, optional `\t<timestamp>`). */
function headerPath(rest: string, prefix: 'a/' | 'b/'): string | null {
  let value = rest;
  if (!value.startsWith('"')) {
    const tab = value.indexOf('\t');
    if (tab >= 0) value = value.slice(0, tab);
  }
  value = unquoteGitPath(value);
  if (value === '/dev/null') return null;
  return stripPrefix(value, prefix);
}

/** Paths of `diff --git a/x b/y` when unambiguous (identical paths, or quoted). */
function gitHeaderPaths(rest: string): { a: string; b: string } | null {
  // Quoted form (paths with special characters): "a/x y" "b/x y", possibly mixed with a bare path.
  if (rest.includes('"')) {
    const m = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
    return m ? { a: stripPrefix(unquoteGitPath(m[1]!), 'a/'), b: stripPrefix(unquoteGitPath(m[2]!), 'b/') } : null;
  }
  // No space inside the paths: a single separator.
  const parts = rest.split(' ');
  if (parts.length === 2) return { a: stripPrefix(parts[0]!, 'a/'), b: stripPrefix(parts[1]!, 'b/') };
  // Same path with spaces on both sides: "a/P b/P" → |P| = (len - 5) / 2.
  if (rest.startsWith('a/')) {
    const len = (rest.length - 5) / 2;
    if (Number.isInteger(len) && len > 0) {
      const a = rest.slice(2, 2 + len);
      const tail = rest.slice(2 + len);
      if (tail === ` b/${a}`) return { a, b: a };
    }
  }
  return null;
}

interface ParserState {
  files: DiffFile[];
  file: DiffFile | null;
  hunk: DiffHunk | null;
  oldNo: number;
  newNo: number;
  oldLeft: number;
  newLeft: number;
  /** Path read on the last `---` line (null = /dev/null, undefined = none yet). */
  headerOld: string | null | undefined;
}

function startFile(st: ParserState): DiffFile {
  const file: DiffFile = { path: '', oldPath: null, status: 'M', additions: 0, deletions: 0, binary: false, hunks: [] };
  st.files.push(file);
  st.file = file;
  st.hunk = null;
  st.oldLeft = 0;
  st.newLeft = 0;
  st.headerOld = undefined;
  return file;
}

/** Consumes one line of an open hunk. Returns false when the line does not belong to the hunk. */
function readHunkLine(st: ParserState, file: DiffFile, hunk: DiffHunk, line: string, isLast: boolean): boolean {
  const marker = line[0];
  if (marker === '+') {
    hunk.lines.push({ type: 'add', oldNumber: null, newNumber: st.newNo++, text: line.slice(1) });
    st.newLeft--;
    file.additions++;
    return true;
  }
  if (marker === '-') {
    hunk.lines.push({ type: 'del', oldNumber: st.oldNo++, newNumber: null, text: line.slice(1) });
    st.oldLeft--;
    file.deletions++;
    return true;
  }
  if (marker === ' ' || line === '') {
    // Some tools drop the space of empty context lines; the final split element is '' too.
    if (line === '' && isLast) return true;
    hunk.lines.push({ type: 'context', oldNumber: st.oldNo++, newNumber: st.newNo++, text: line.slice(1) });
    st.oldLeft--;
    st.newLeft--;
    return true;
  }
  if (marker === '\\') {
    const last = hunk.lines[hunk.lines.length - 1];
    if (last) last.noNewlineAtEnd = true;
    return true;
  }
  return false;
}

/** File metadata lines between `diff --git` and the first hunk. */
function readMetaLine(file: DiffFile, line: string): void {
  if (line.startsWith('new file mode')) file.status = 'A';
  else if (line.startsWith('deleted file mode')) file.status = 'D';
  else if (line.startsWith('rename from ')) {
    file.oldPath = unquoteGitPath(line.slice('rename from '.length));
    file.status = 'R';
  } else if (line.startsWith('rename to ')) {
    file.path = unquoteGitPath(line.slice('rename to '.length));
    file.status = 'R';
  } else if (line.startsWith('copy to ')) {
    file.path = unquoteGitPath(line.slice('copy to '.length));
    file.status = 'A';
  } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
    file.binary = true;
    const bin = /^Binary files (.+) and (.+) differ$/.exec(line);
    if (bin && !file.path) {
      const a = headerPath(bin[1]!, 'a/');
      const b = headerPath(bin[2]!, 'b/');
      file.path = b ?? a ?? '';
      if (!a) file.status = 'A';
      if (!b) file.status = 'D';
    }
  }
}

/**
 * Parses `git diff` / `diff -u` text into files. Unknown lines are ignored; malformed input never
 * throws (it only yields fewer hunks).
 */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const st: ParserState = { files: [], file: null, hunk: null, oldNo: 0, newNo: 0, oldLeft: 0, newLeft: 0, headerOld: undefined };
  const lines = patch.split('\n');

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);

    // Inside a hunk the counts drive parsing, so `--- x` can be a deleted line starting with "-- ".
    if (st.file && st.hunk && (st.oldLeft > 0 || st.newLeft > 0)) {
      if (readHunkLine(st, st.file, st.hunk, line, i === lines.length - 1)) continue;
      st.oldLeft = 0; // truncated hunk: fall through to header parsing
      st.newLeft = 0;
    }
    if (line.startsWith('\\') && st.hunk) {
      const last = st.hunk.lines[st.hunk.lines.length - 1];
      if (last) last.noNewlineAtEnd = true;
      continue;
    }

    if (line.startsWith('diff --git ')) {
      const file = startFile(st);
      const paths = gitHeaderPaths(line.slice('diff --git '.length));
      if (paths) {
        file.path = paths.b;
        if (paths.a !== paths.b) file.oldPath = paths.a;
      }
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      const file = st.file ?? startFile(st);
      const hunk: DiffHunk = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        section: (m[5] ?? '').trim(),
        lines: [],
      };
      file.hunks.push(hunk);
      st.hunk = hunk;
      st.oldNo = hunk.oldStart;
      st.newNo = hunk.newStart;
      st.oldLeft = hunk.oldLines;
      st.newLeft = hunk.newLines;
      continue;
    }

    if (line.startsWith('--- ')) {
      // A `---` after a file that already has hunks starts another plain unified diff (no `diff --git`).
      const file = !st.file || st.file.hunks.length > 0 ? startFile(st) : st.file;
      st.headerOld = headerPath(line.slice(4), 'a/');
      if (st.headerOld === null) file.status = 'A';
      continue;
    }
    if (line.startsWith('+++ ')) {
      const file = st.file ?? startFile(st);
      const headerNew = headerPath(line.slice(4), 'b/');
      if (headerNew === null) {
        file.status = 'D';
        if (st.headerOld) file.path = st.headerOld;
      } else {
        file.path = headerNew;
        if (st.headerOld && st.headerOld !== headerNew && file.status !== 'A') {
          file.oldPath = st.headerOld;
          if (file.status === 'M') file.status = 'R';
        }
      }
      continue;
    }

    if (st.file) readMetaLine(st.file, line);
  }
  return st.files.filter((f) => f.path !== '' || f.hunks.length > 0);
}


/**
 * What the views need from a line: `parseUnifiedDiff` lines and the runner's `FileDiff` lines
 * (`@nuera/shared/runner`, `noNewline` instead of `noNewlineAtEnd`) both fit.
 */
export type DiffLineLike = Pick<DiffLine, 'type' | 'oldNumber' | 'newNumber' | 'text'>;

export type SplitCellType = DiffLineType | 'empty';

export interface SplitCell {
  type: SplitCellType;
  number: number | null;
  text: string;
}

export interface SplitRow {
  left: SplitCell;
  right: SplitCell;
}

const EMPTY: SplitCell = { type: 'empty', number: null, text: '' };

/**
 * Side-by-side pairing (W4 `Diff côte à côte`): a run of deletions followed by additions is paired
 * line by line; the shorter side is padded with empty filler cells.
 */
export function toSplitRows(lines: readonly DiffLineLike[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.type === 'context') {
      rows.push({
        left: { type: 'context', number: line.oldNumber, text: line.text },
        right: { type: 'context', number: line.newNumber, text: line.text },
      });
      i++;
      continue;
    }
    const dels: DiffLineLike[] = [];
    const adds: DiffLineLike[] = [];
    while (i < lines.length && lines[i]!.type === 'del') dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.type === 'add') adds.push(lines[i++]!);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const d = dels[k];
      const a = adds[k];
      rows.push({
        left: d ? { type: 'del', number: d.oldNumber, text: d.text } : EMPTY,
        right: a ? { type: 'add', number: a.newNumber, text: a.text } : EMPTY,
      });
    }
  }
  return rows;
}

/** Totals of a set of files (`4 fichiers · +152 −12`). */
export interface DiffTotals {
  files: number;
  additions: number;
  deletions: number;
}

export function diffTotals(files: ReadonlyArray<Pick<DiffFile, 'additions' | 'deletions'>>): DiffTotals {
  const totals: DiffTotals = { files: 0, additions: 0, deletions: 0 };
  for (const f of files) {
    totals.files += 1;
    totals.additions += f.additions;
    totals.deletions += f.deletions;
  }
  return totals;
}
