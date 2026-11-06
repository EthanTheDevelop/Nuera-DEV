import type { TestCase, TestReport } from '@nuera/shared/runner';

/**
 * Reads test results from the exact output of a test command (Vitest, Jest, Playwright,
 * node:test). Nothing is estimated: counts come from the reporter's own summary when it printed
 * one, otherwise from the per-test lines seen so far (live runs).
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[PX^_][^\u001b]*\u001b\\|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CSI = /^\u001b\[([0-?]*)[ -/]*([@-~])$/;

/**
 * Plain text of a terminal output. Cursor movements are not mere decoration: a Windows PTY
 * (ConPTY) repaints the screen and replaces blank lines by « go to row N » (`ESC[5;1H`) instead of
 * `\r\n`, and compresses runs of spaces into « move right » (`ESC[6C`). Removing them would glue
 * two lines together (« … produit 2ms Test Files … »), so a move to another row ends the line and
 * a move right keeps its spaces.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(ANSI, (sequence) => {
      const csi = CSI.exec(sequence);
      if (!csi) return '';
      const [, params = '', final] = csi;
      // CUP / HVP (row;col), CNL, CPL, VPA, CUU, CUD: another row.
      if (final === 'H' || final === 'f' || final === 'E' || final === 'F' || final === 'd' || final === 'A' || final === 'B') return '\n';
      // CUF: cursor forward = that many blanks (bounded).
      if (final === 'C') return ' '.repeat(Math.min(200, Math.max(1, Number.parseInt(params, 10) || 1)));
      return '';
    })
    .replace(/\r(?!\n)/g, '\n');
}

function toMs(value: string, unit: string): number {
  const n = Number(value.replace(',', '.'));
  if (unit === 'ms') return n;
  if (unit === 'm' || unit === 'min') return n * 60_000;
  return n * 1000;
}

const PASS_MARKS = new Set(['✓', '✔', '√', 'ok']);
const FAIL_MARKS = new Set(['✘', '×', '✗', 'x', 'X', '✖']);
const SKIP_MARKS = new Set(['-', '↓', '○', '◌']);

type Framework = TestReport['counts']['framework'];

export class TestOutputParser {
  private text = '';
  private framework: Framework = 'unknown';
  private tests = new Map<string, TestCase>();
  private declaredTotal: number | null = null;
  private summary: { passed: number; failed: number; skipped: number; total: number | null; durationMs: number | null } | null = null;
  private failures: TestReport['failures'] = [];
  private lineBuffer = '';

  /** Feed raw output (ANSI allowed). */
  push(chunk: string): void {
    const clean = stripAnsi(chunk);
    this.text = (this.text + clean).slice(-512 * 1024);
    this.lineBuffer += clean;
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';
    for (const line of lines) this.readLine(line);
  }

  private readLine(raw: string): void {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) return;
    let m: RegExpExecArray | null;

    // Playwright: "Running 24 tests using 4 workers"
    if ((m = /^\s*Running (\d+) tests? using \d+ workers?/.exec(line))) {
      this.framework = 'playwright';
      this.declaredTotal = Number(m[1]);
      return;
    }
    // Playwright list reporter: "  ✓  1 [chromium] › devis.spec.ts:12:5 › devis › création (3.1s)"
    if ((m = /^\s*(✓|✔|✘|×|✗|-|ok)\s+\d+\s+(?:\[[^\]]+\]\s+›\s+)?(.+?)\s+\((\d+(?:[.,]\d+)?)(ms|s|m)\)\s*$/.exec(line))) {
      this.framework = 'playwright';
      const { name, location } = splitPlaywrightTitle(m[2]!);
      this.record(name, markStatus(m[1]!), toMs(m[3]!, m[4]!), location);
      return;
    }
    // Playwright summary: "  22 passed (31.2s)", "  1 failed", "  2 skipped", "  1 flaky"
    if (this.framework === 'playwright' && (m = /^\s*(\d+) (passed|failed|flaky|skipped|did not run|interrupted)(?: \((\d+(?:[.,]\d+)?)(ms|s|m)\))?\s*$/.exec(line))) {
      const s = (this.summary ??= { passed: 0, failed: 0, skipped: 0, total: null, durationMs: null });
      const n = Number(m[1]);
      if (m[2] === 'passed' || m[2] === 'flaky') s.passed += n;
      else if (m[2] === 'failed' || m[2] === 'interrupted') s.failed += n;
      else s.skipped += n;
      if (m[3]) s.durationMs = toMs(m[3], m[4]!);
      return;
    }
    // Playwright failure block header: "  1) [chromium] › tests/e2e/devis.spec.ts:84:5 › devis › export PDF ───"
    if ((m = /^\s*\d+\) (?:\[[^\]]+\]\s+›\s+)?(.+?)\s*─*\s*$/.exec(line)) && line.includes('›')) {
      const { name, location } = splitPlaywrightTitle(m[1]!);
      this.failures.push({ name, location, excerpt: '' });
      return;
    }

    // Vitest summary: "      Tests  1 failed | 9 passed (10)"
    if ((m = /^\s*Tests\s{2,}(.+)\((\d+)\)\s*$/.exec(line))) {
      this.framework = 'vitest';
      const parts = m[1]!;
      this.summary = {
        passed: countIn(parts, 'passed'),
        failed: countIn(parts, 'failed'),
        skipped: countIn(parts, 'skipped') + countIn(parts, 'todo'),
        total: Number(m[2]),
        durationMs: this.summary?.durationMs ?? null,
      };
      return;
    }
    if ((m = /^\s*Duration\s+(\d+(?:[.,]\d+)?)(ms|s|m)\b/.exec(line)) && this.framework === 'vitest') {
      if (this.summary) this.summary.durationMs = toMs(m[1]!, m[2]!);
      return;
    }
    if (/^\s*Test Files\s{2,}/.test(line)) {
      this.framework = 'vitest';
      return;
    }
    // Vitest verbose test line: " ✓ src/a.test.ts > suite > test 3ms" / " × … 12ms"
    if ((m = /^\s*(✓|✔|×|✗|↓)\s+(.+?)\s+(\d+(?:[.,]\d+)?)\s?(ms|s)\s*$/.exec(line)) && !/\(\d+ tests?\)/.test(line)) {
      if (this.framework === 'unknown') this.framework = 'vitest';
      this.record(m[2]!, markStatus(m[1]!), toMs(m[3]!, m[4]!), null);
      return;
    }
    // Vitest failure header: " FAIL  src/a.test.ts > suite > test"
    if ((m = /^\s*FAIL\s+(.+)$/.exec(line)) && line.includes('>')) {
      this.failures.push({ name: m[1]!.trim(), location: null, excerpt: '' });
      return;
    }

    // Jest: "Tests:       1 failed, 9 passed, 10 total"
    if ((m = /^\s*Tests:\s+(.+?)(\d+) total\s*$/.exec(line))) {
      this.framework = 'jest';
      this.summary = {
        passed: countIn(m[1]!, 'passed'),
        failed: countIn(m[1]!, 'failed'),
        skipped: countIn(m[1]!, 'skipped') + countIn(m[1]!, 'todo'),
        total: Number(m[2]),
        durationMs: this.summary?.durationMs ?? null,
      };
      return;
    }
    if ((m = /^\s*Time:\s+(\d+(?:[.,]\d+)?)\s*(ms|s|m)\b/.exec(line)) && this.framework === 'jest') {
      if (this.summary) this.summary.durationMs = toMs(m[1]!, m[2]!);
      return;
    }
    if ((m = /^\s*●\s+(.+›.+)$/.exec(line))) {
      this.framework = this.framework === 'unknown' ? 'jest' : this.framework;
      this.failures.push({ name: m[1]!.trim(), location: null, excerpt: '' });
      return;
    }

    // node:test TAP summary
    if ((m = /^# (tests|pass|fail|skipped|todo|duration_ms) (\d+(?:\.\d+)?)/.exec(line))) {
      this.framework = 'node';
      const s = (this.summary ??= { passed: 0, failed: 0, skipped: 0, total: null, durationMs: null });
      const n = Number(m[2]);
      if (m[1] === 'tests') s.total = n;
      else if (m[1] === 'pass') s.passed = n;
      else if (m[1] === 'fail') s.failed = n;
      else if (m[1] === 'duration_ms') s.durationMs = n;
      else s.skipped += n;
      return;
    }

    // Excerpt lines of the current failure block (exact text, a few lines).
    const current = this.failures[this.failures.length - 1];
    if (current && current.excerpt.split('\n').length < 8 && /\S/.test(line)) {
      const text = line.trim();
      if (/^(Error|AssertionError|Expected|Received|expect\(|at |›|\d+ \|)/.test(text) || current.excerpt.length > 0) {
        current.excerpt = current.excerpt ? `${current.excerpt}\n${text}` : text;
        if (!current.location) {
          const loc = /([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+)/.exec(text);
          if (loc) current.location = `${loc[1]}:${loc[2]}`;
        }
      }
    }
  }

  private record(name: string, status: TestCase['status'], durationMs: number | null, location: string | null): void {
    let key = name;
    const previous = this.tests.get(key);
    if (previous && previous.status !== 'running') {
      // A re-run is a separate row (« … (relance) »).
      key = `${name} (relance)`;
      name = key;
    }
    this.tests.set(key, { name, status, durationMs, location });
  }

  /** Current report, or null when no test output was recognised. */
  report(options: { finished?: boolean } = {}): TestReport | null {
    if (options.finished && this.lineBuffer.trim()) {
      const pending = this.lineBuffer;
      this.lineBuffer = '';
      this.readLine(pending);
    }
    const tests = [...this.tests.values()];
    if (!this.summary && tests.length === 0 && this.framework === 'unknown') return null;
    const counted = {
      passed: tests.filter((t) => t.status === 'passed').length,
      failed: tests.filter((t) => t.status === 'failed').length,
      skipped: tests.filter((t) => t.status === 'skipped').length,
    };
    const s = this.summary;
    const passed = s ? s.passed : counted.passed;
    const failed = s ? s.failed : counted.failed;
    const skipped = s ? s.skipped : counted.skipped;
    const total = s?.total ?? (this.declaredTotal !== null ? this.declaredTotal : passed + failed + skipped);
    const running = options.finished || s ? 0 : Math.max(0, total - passed - failed - skipped);
    return {
      counts: { passed, failed, skipped, running, total, durationMs: s?.durationMs ?? null, framework: this.framework },
      tests: tests.slice(-500),
      failures: this.failures.slice(0, 20).map((f) => ({ ...f, excerpt: f.excerpt.slice(0, 2000) })),
    };
  }
}

function markStatus(mark: string): TestCase['status'] {
  if (PASS_MARKS.has(mark)) return 'passed';
  if (FAIL_MARKS.has(mark)) return 'failed';
  if (SKIP_MARKS.has(mark)) return 'skipped';
  return 'passed';
}

function countIn(text: string, word: string): number {
  const m = new RegExp(`(\\d+) ${word}`).exec(text);
  return m ? Number(m[1]) : 0;
}

/** "devis.spec.ts:12:5 › devis › création" → name "devis › création", location "devis.spec.ts:12". */
function splitPlaywrightTitle(title: string): { name: string; location: string | null } {
  const parts = title.split(' › ');
  const first = parts[0] ?? '';
  const loc = /^(.+?):(\d+)(?::\d+)?$/.exec(first.trim());
  if (loc && parts.length > 1) return { name: parts.slice(1).join(' › '), location: `${loc[1]}:${loc[2]}` };
  return { name: title.trim(), location: null };
}

/** One-shot helper for a complete output (Bash tool result). */
export function parseTestOutput(output: string): TestReport | null {
  const parser = new TestOutputParser();
  parser.push(output.endsWith('\n') ? output : `${output}\n`);
  const report = parser.report({ finished: true });
  if (!report) return null;
  if (report.counts.total === 0 && report.tests.length === 0) return null;
  return report;
}
