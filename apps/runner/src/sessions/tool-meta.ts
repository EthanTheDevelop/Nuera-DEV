import { formatToolSummary } from '@nuera/shared/events';
import type { PlanItem, ToolMeta } from '@nuera/shared/runner';
import { capText, redactSecrets } from '../safety/redact';
import { parseTestOutput } from '../runs/test-parser';

/**
 * Derives what a tool line shows (target + meta) from the official hook payloads
 * (`tool_input`, `tool_response`). Shapes vary between CLI versions: every accessor is tolerant
 * and returns null rather than guessing.
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function relativeTo(cwd: string | null, filePath: string): string {
  if (!cwd) return filePath;
  const norm = (p: string) => p.replace(/\\/g, '/');
  const f = norm(filePath);
  const c = norm(cwd).replace(/\/+$/, '');
  const same = process.platform === 'win32' ? f.toLowerCase().startsWith(`${c.toLowerCase()}/`) : f.startsWith(`${c}/`);
  return same ? f.slice(c.length + 1) : filePath;
}

function firstLine(text: string, max = 300): string {
  const line = text.split(/\r?\n/)[0] ?? '';
  const more = text.includes('\n');
  return line.length > max ? `${line.slice(0, max)}…` : more ? `${line} …` : line;
}

/** Target shown after the tool name (« CLAUDE.md », « npm run test -- crm », « src/**\/*.tsx »). */
export function toolTarget(tool: string, input: unknown, cwd: string | null): string | null {
  if (!isObj(input)) return null;
  const filePath = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'NotebookRead':
      return filePath ? relativeTo(cwd, filePath) : null;
    case 'Bash':
    case 'BashOutput':
    case 'PowerShell':
      return str(input.command) ? redactSecrets(firstLine(str(input.command)!)) : str(input.bash_id);
    case 'Glob': {
      const pattern = str(input.pattern);
      const base = str(input.path);
      if (!pattern) return null;
      return base ? `${relativeTo(cwd, base).replace(/\/+$/, '')}/${pattern}` : pattern;
    }
    case 'Grep': {
      const pattern = str(input.pattern);
      const base = str(input.path) ?? str(input.glob);
      return pattern ? (base ? `${pattern} · ${relativeTo(cwd, base)}` : pattern) : null;
    }
    case 'WebFetch':
      return str(input.url);
    case 'WebSearch':
      return str(input.query);
    case 'Task':
    case 'Agent':
      return str(input.description) ?? str(input.subagent_type);
    case 'TodoWrite':
      return null;
    default: {
      if (filePath) return relativeTo(cwd, filePath);
      for (const value of Object.values(input)) {
        if (typeof value === 'string' && value.trim()) return redactSecrets(firstLine(value, 200));
      }
      return null;
    }
  }
}

function countPatch(patch: unknown): { added: number; removed: number } | null {
  if (!Array.isArray(patch)) return null;
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    if (!isObj(hunk) || !Array.isArray(hunk.lines)) continue;
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

function lineCount(text: string): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** Line-level +/− between two snippets (LCS; bounded). */
export function lineDiffCounts(before: string, after: string): { added: number; removed: number } {
  const a = before === '' ? [] : before.replace(/\r\n/g, '\n').split('\n');
  const b = after === '' ? [] : after.replace(/\r\n/g, '\n').split('\n');
  if (a.length * b.length > 4_000_000) return { added: b.length, removed: a.length };
  const prev = Array.from<number>({ length: b.length + 1 }).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j]!;
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j]!, prev[j - 1]!);
      diag = tmp;
    }
  }
  const common = prev[b.length]!;
  return { added: b.length - common, removed: a.length - common };
}

export interface ToolOutcome {
  meta: ToolMeta | null;
  output: string | null;
  outputTruncated: boolean;
  tests: ReturnType<typeof parseTestOutput>;
}

const OUTPUT_CAP = 16 * 1024;

/** Meta of a finished tool from `tool_input` + `tool_response` (+ `duration_ms`). */
export function toolOutcome(tool: string, input: unknown, response: unknown, durationMs: number | null, errorText: string | null): ToolOutcome {
  const none: ToolOutcome = { meta: null, output: null, outputTruncated: false, tests: null };
  const resp = isObj(response) ? response : null;
  switch (tool) {
    case 'Read': {
      const file = resp && isObj(resp.file) ? resp.file : null;
      const n = num(file?.numLines) ?? num(resp?.numLines);
      if (n !== null) return { ...none, meta: { kind: 'lines', count: n } };
      const content = str(file?.content) ?? str(resp?.content) ?? str(response);
      return content !== null ? { ...none, meta: { kind: 'lines', count: lineCount(content) } } : none;
    }
    case 'Glob': {
      const n = num(resp?.numFiles) ?? (Array.isArray(resp?.filenames) ? (resp.filenames as unknown[]).length : null);
      return n !== null ? { ...none, meta: { kind: 'matches', count: n, unit: 'files' } } : none;
    }
    case 'Grep': {
      const mode = str(resp?.mode) ?? (isObj(input) ? str(input.output_mode) : null) ?? 'files_with_matches';
      if (mode === 'content') {
        const n = num(resp?.numLines) ?? (str(resp?.content) !== null ? lineCount(str(resp!.content)!) : null);
        return n !== null ? { ...none, meta: { kind: 'matches', count: n, unit: 'lines' } } : none;
      }
      if (mode === 'count') {
        const n = num(resp?.numMatches);
        return n !== null ? { ...none, meta: { kind: 'matches', count: n, unit: 'matches' } } : none;
      }
      const n = num(resp?.numFiles) ?? (Array.isArray(resp?.filenames) ? (resp.filenames as unknown[]).length : null);
      return n !== null ? { ...none, meta: { kind: 'matches', count: n, unit: 'files' } } : none;
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const patch = countPatch(resp?.structuredPatch);
      if (patch && (patch.added > 0 || patch.removed > 0)) return { ...none, meta: { kind: 'diff', ...patch } };
      if (!isObj(input)) return none;
      if (tool === 'Write') {
        const content = str(input.content);
        if (content === null) return none;
        if (str(resp?.type) === 'update' && str(resp?.originalFile) !== null) {
          return { ...none, meta: { kind: 'diff', ...lineDiffCounts(str(resp!.originalFile)!, content) } };
        }
        return { ...none, meta: { kind: 'diff', added: lineCount(content), removed: 0 } };
      }
      if (tool === 'Edit') {
        const before = str(input.old_string);
        const after = str(input.new_string);
        return before !== null && after !== null ? { ...none, meta: { kind: 'diff', ...lineDiffCounts(before, after) } } : none;
      }
      if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
        let added = 0;
        let removed = 0;
        for (const e of input.edits) {
          if (!isObj(e)) continue;
          const c = lineDiffCounts(str(e.old_string) ?? '', str(e.new_string) ?? '');
          added += c.added;
          removed += c.removed;
        }
        return { ...none, meta: { kind: 'diff', added, removed } };
      }
      return none;
    }
    case 'Bash':
    case 'PowerShell': {
      const stdout = str(resp?.stdout) ?? (typeof response === 'string' ? response : '') ?? '';
      const stderr = str(resp?.stderr) ?? '';
      const combined = [stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n' : '');
      const errorOut = errorText ?? '';
      const text = combined || errorOut;
      const exitMatch = /exit code[:\s]+(\d+)/i.exec(errorOut) ?? /exit code[:\s]+(\d+)/i.exec(str(resp?.returnCodeInterpretation) ?? '');
      const exitCode = num(resp?.exitCode) ?? num(resp?.exit_code) ?? (exitMatch ? Number(exitMatch[1]) : errorText === null ? 0 : null);
      const tests = text ? parseTestOutput(text) : null;
      const capped = capText(redactSecrets(text), OUTPUT_CAP);
      return {
        meta: {
          kind: 'command',
          exitCode,
          durationMs,
          interrupted: resp?.interrupted === true,
          tests: tests ? tests.counts : null,
        },
        output: text ? capped.text : null,
        outputTruncated: capped.truncated,
        tests,
      };
    }
    default:
      return durationMs !== null ? { ...none, meta: { kind: 'duration', durationMs } } : none;
  }
}

export function toolSummary(status: 'running' | 'done' | 'error' | 'denied', meta: ToolMeta | null): string | null {
  return formatToolSummary(status, meta);
}

/** TodoWrite → plan items (tolerant to the item shape). */
export function planFromTodoWrite(input: unknown): PlanItem[] | null {
  if (!isObj(input) || !Array.isArray(input.todos)) return null;
  const items: PlanItem[] = [];
  for (const todo of input.todos) {
    if (!isObj(todo)) continue;
    const content = str(todo.content) ?? str(todo.subject) ?? str(todo.title);
    if (!content) continue;
    const status = str(todo.status);
    items.push({
      content,
      status: status === 'completed' || status === 'in_progress' ? status : 'pending',
      activeForm: str(todo.activeForm) ?? str(todo.active_form),
    });
  }
  return items;
}
