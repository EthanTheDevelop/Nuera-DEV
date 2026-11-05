/**
 * DEV-ONLY sample props for the /kit/composites gallery. Copy taken verbatim from the Figma frames
 * (D05, W1–W7, S1–S5, D01–D07). Never imported by application code (not exported from ../index.ts).
 */
import { parseUnifiedDiff, type DiffFile } from '../lib/diff';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const PIPELINE_PATCH = [
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
  '@@ -41,4 +44,6 @@',
  '         <StageColumn',
  '           stage={stage}',
  '-          total={total}',
  '+          total={totals[stage.id] ?? 0}',
  '+          onDragStart={setDragged}',
  '+          isDragging={dragged?.stage === stage.id}',
  '         />',
  'diff --git a/src/modules/crm/pipeline-totals.ts b/src/modules/crm/pipeline-totals.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/modules/crm/pipeline-totals.ts',
  '@@ -0,0 +1,6 @@',
  "+import type { Deal, StageTotals } from './types';",
  '+',
  '+export function computeStageTotals(deals: Deal[]): StageTotals {',
  '+  return deals.reduce<StageTotals>((acc, deal) => ({ ...acc, [deal.stageId]: (acc[deal.stageId] ?? 0) + deal.amount }), {});',
  '+}',
  '+',
  'diff --git a/src/modules/crm/__tests__/pipeline-totals.test.ts b/src/modules/crm/__tests__/pipeline-totals.test.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/modules/crm/__tests__/pipeline-totals.test.ts',
  '@@ -0,0 +1,3 @@',
  "+import { describe, expect, it } from 'vitest';",
  "+import { computeStageTotals } from '../pipeline-totals';",
  "+describe('computeStageTotals', () => it('sums each stage', () => expect(computeStageTotals([])).toEqual({})));",
  'diff --git a/src/modules/crm/legacy-board.tsx b/src/modules/crm/legacy-board.tsx',
  'deleted file mode 100644',
  '--- a/src/modules/crm/legacy-board.tsx',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  "-export { PipelineBoard as LegacyBoard } from './PipelineBoard';",
  '-// À supprimer après la migration du tableau.',
  '',
].join('\n');

export const PIPELINE_FILES: DiffFile[] = parseUnifiedDiff(PIPELINE_PATCH);

export const TEST_OUTPUT = [
  ' \u001b[32m✓\u001b[39m pipeline-totals.test.ts (6 tests) 41 ms',
  ' \u001b[32m✓\u001b[39m PipelineBoard.test.tsx (4 tests) 212 ms',
  '',
  ' Test Files  2 passed (2)',
  '      Tests  10 passed (10)',
].join('\n');

export const FAILED_OUTPUT = [
  ' ✓ pipeline-totals.test.ts (6 tests) 41 ms',
  ' ✗ PipelineBoard.test.tsx > déplace une affaire (4 tests | 2 failed) 212 ms',
  '   → expected 2 600 to be 2 400',
  '',
  ' Test Files  1 failed | 1 passed (2)',
  '      Tests  2 failed | 8 passed (10)',
].join('\n');

export const CLAUDE_MARKDOWN = [
  'Le tableau et le calcul des totaux sont en place. J\'ai écrit les tests de `pipeline-totals.ts` ; je lance maintenant la suite du module pour les vérifier.',
  '',
  '- **Colonnes glissables** avec `@dnd-kit/core`',
  '- Total par étape dans [la fonction dédiée](https://github.com/nuera-studio/nuera-os)',
  '',
  '```ts',
  'export function computeStageTotals(deals: Deal[]): StageTotals {',
  '  return deals.reduce(sumByStage, {});',
  '}',
  '```',
  '',
  'Du HTML brut reste du texte : <script>alert(1)</script>',
].join('\n');
