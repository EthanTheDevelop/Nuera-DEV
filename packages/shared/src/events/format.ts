import { formatDuration, formatNumber, plural } from '../format';
import type { TestCounts, ToolMeta } from '../runner/sessions';

/** Short durations as in the Workspace frames: « 3,2 s », « 12 s », « 4 min », « 1 h 05 ». */
export function formatShortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 s';
  if (ms < 10_000) return `${formatNumber(Math.round(ms / 100) / 10, 1)} s`;
  return formatDuration(ms);
}

/** « 10 / 10 réussis », « 9 / 10 réussis · 1 échec ». */
export function formatTestCounts(counts: Pick<TestCounts, 'passed' | 'failed' | 'total'>): string {
  const base = `${formatNumber(counts.passed)} / ${formatNumber(counts.total)} ${passedWord(counts.passed)}`;
  return counts.failed > 0 ? `${base} · ${plural(counts.failed, 'échec')}` : base;
}

const passedWord = (count: number) => (Math.abs(count) >= 2 ? 'réussis' : 'réussi');

/** « +46 −12 » (U+2212 minus), « +38 », « −4 ». */
export function formatDiffCounts(added: number, removed: number): string {
  if (removed > 0 && added > 0) return `+${formatNumber(added)} −${formatNumber(removed)}`;
  if (removed > 0) return `−${formatNumber(removed)}`;
  return `+${formatNumber(added)}`;
}

/**
 * French meta shown at the end of a tool line (Figma `Dev · Ligne d'outil`):
 * « 212 lignes », « 14 fichiers », « +46 −12 », « 10 réussis · 3,2 s », « code 1 · 2 échecs »,
 * « en cours », « refusé ». Returns null when nothing reliable can be said.
 */
export function formatToolSummary(
  status: 'running' | 'done' | 'error' | 'denied',
  meta: ToolMeta | null,
): string | null {
  if (status === 'running') return 'en cours';
  if (status === 'denied') return 'refusé';
  if (!meta) return status === 'error' ? 'échec' : null;
  switch (meta.kind) {
    case 'lines':
      return plural(meta.count, 'ligne');
    case 'matches':
      if (meta.unit === 'files') return plural(meta.count, 'fichier');
      if (meta.unit === 'lines') return plural(meta.count, 'ligne');
      return plural(meta.count, 'résultat');
    case 'diff':
      return formatDiffCounts(meta.added, meta.removed);
    case 'duration':
      return formatShortDuration(meta.durationMs);
    case 'command': {
      const parts: string[] = [];
      const failed = status === 'error' || (meta.exitCode !== null && meta.exitCode !== 0);
      if (failed && meta.exitCode !== null) parts.push(`code ${meta.exitCode}`);
      if (meta.interrupted) parts.push('interrompu');
      if (meta.tests) {
        if (meta.tests.failed > 0) parts.push(plural(meta.tests.failed, 'échec'));
        else parts.push(`${formatNumber(meta.tests.passed)} ${passedWord(meta.tests.passed)}`);
      }
      if (!failed && meta.durationMs !== null) parts.push(formatShortDuration(meta.durationMs));
      if (parts.length === 0) return failed ? 'échec' : null;
      return parts.join(' · ');
    }
    default:
      return null;
  }
}
