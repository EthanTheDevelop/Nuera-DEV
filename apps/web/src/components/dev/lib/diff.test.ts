import { describe, expect, it } from 'vitest';
import { diffTotals, parseUnifiedDiff, toSplitRows, unquoteGitPath } from './diff';

const PIPELINE = [
  'diff --git a/src/modules/crm/PipelineBoard.tsx b/src/modules/crm/PipelineBoard.tsx',
  'index 83db48f..bf269f4 100644',
  '--- a/src/modules/crm/PipelineBoard.tsx',
  '+++ b/src/modules/crm/PipelineBoard.tsx',
  '@@ -12,6 +12,8 @@ export function PipelineBoard()',
  '   const stages = useStages(projectId);',
  '   const deals = useDeals(projectId);',
  '-  const total = deals.reduce(sum, 0);',
  '+  const totals = computeStageTotals(deals);',
  '+  const [dragged, setDragged] = useState(null);',
  ' ',
  '   return (',
  '     <DndContext onDragEnd={moveDeal}>',
  '@@ -41,4 +44,8 @@',
  '         <StageColumn',
  '           stage={stage}',
  '-          total={total}',
  '+          total={totals[stage.id] ?? 0}',
  '+          onDragStart={setDragged}',
  '+          isDragging={dragged?.stage === stage.id}',
  '         />',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('reads hunks, numbers and totals (D05 sample)', () => {
    const [file] = parseUnifiedDiff(PIPELINE);
    expect(file).toBeDefined();
    expect(file!.path).toBe('src/modules/crm/PipelineBoard.tsx');
    expect(file!.status).toBe('M');
    expect(file!.hunks).toHaveLength(2);
    expect(file!.additions).toBe(5);
    expect(file!.deletions).toBe(2);
    const h1 = file!.hunks[0]!;
    expect(h1.section).toBe('export function PipelineBoard()');
    expect(h1.lines.map((l) => [l.type, l.oldNumber, l.newNumber])).toEqual([
      ['context', 12, 12],
      ['context', 13, 13],
      ['del', 14, null],
      ['add', null, 14],
      ['add', null, 15],
      ['context', 15, 16],
      ['context', 16, 17],
      ['context', 17, 18],
    ]);
    expect(h1.lines[5]!.text).toBe('');
    const h2 = file!.hunks[1]!;
    expect(h2.lines.at(-1)).toMatchObject({ type: 'context', oldNumber: 44, newNumber: 49 });
  });

  it('handles new, deleted, renamed and binary files', () => {
    const patch = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const a = 1;',
      '+export const b = 2;',
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
      'diff --git a/a b.ts b/c d.ts',
      'similarity index 90%',
      'rename from a b.ts',
      'rename to c d.ts',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');
    const files = parseUnifiedDiff(patch);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary])).toEqual([
      ['src/new.ts', 'A', 2, 0, false],
      ['src/old.ts', 'D', 0, 1, false],
      ['c d.ts', 'R', 0, 0, false],
      ['logo.png', 'M', 0, 0, true],
    ]);
    expect(files[2]!.oldPath).toBe('a b.ts');
  });

  it('keeps deleted lines that look like headers and marks missing final newlines', () => {
    const patch = [
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1,2 +1,1 @@',
      '--- a comment',
      ' select 1;',
      '\\ No newline at end of file',
    ].join('\n');
    const [file] = parseUnifiedDiff(patch);
    expect(file!.path).toBe('q.sql');
    expect(file!.hunks[0]!.lines[0]).toMatchObject({ type: 'del', text: '-- a comment' });
    expect(file!.hunks[0]!.lines[1]).toMatchObject({ type: 'context', noNewlineAtEnd: true });
  });

  it('decodes quoted paths', () => {
    expect(unquoteGitPath('"src/caf\\303\\251.ts"')).toBe('src/café.ts');
    expect(unquoteGitPath('plain.ts')).toBe('plain.ts');
    const [file] = parseUnifiedDiff('diff --git "a/caf\\303\\251 1.ts" "b/caf\\303\\251 1.ts"\n');
    expect(file!.path).toBe('café 1.ts');
  });

  it('never throws on garbage', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(() => parseUnifiedDiff('@@ nope @@\n+x\n-y')).not.toThrow();
  });
});

describe('toSplitRows', () => {
  it('pairs deletions with additions and pads with fillers (W4)', () => {
    const [file] = parseUnifiedDiff(PIPELINE);
    const rows = toSplitRows(file!.hunks[0]!.lines);
    expect(rows.map((r) => [r.left.type, r.left.number, r.right.type, r.right.number])).toEqual([
      ['context', 12, 'context', 12],
      ['context', 13, 'context', 13],
      ['del', 14, 'add', 14],
      ['empty', null, 'add', 15],
      ['context', 15, 'context', 16],
      ['context', 16, 'context', 17],
      ['context', 17, 'context', 18],
    ]);
  });
});

describe('diffTotals', () => {
  it('sums files', () => {
    expect(
      diffTotals([
        { additions: 46, deletions: 12 },
        { additions: 38, deletions: 0 },
        { additions: 54, deletions: 0 },
        { additions: 14, deletions: 0 },
      ]),
    ).toEqual({ files: 4, additions: 152, deletions: 12 });
  });
});
