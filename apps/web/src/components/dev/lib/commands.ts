/**
 * Copy of the D04 `Environnement de développement` rows: label per command kind and the badge of the
 * last real run (`Réussie · il y a 2 h`, `En cours · port 3000`, `10 / 10 réussis · il y a 9 min`).
 * D04 mixes relative times and a clock (`· 10:51`) for runs of the same day: every badge uses the
 * relative time. Nothing is estimated: without a run, the badge says so.
 */
import type { CommandKind, CommandRunStatus } from '@nuera/db';
import { formatNumber, formatRelative, plural } from '@nuera/shared/format';
import { formatRatio, joinParts } from './format';
import type { BadgeTone } from './tones';

export type { CommandKind, CommandRunStatus };

/** Row label (Figma: `Installation`, `Lancement`, `Build`, `Tests`). */
export const COMMAND_KIND_LABEL: Record<CommandKind, string> = {
  install: 'Installation',
  dev: 'Lancement',
  build: 'Build',
  test: 'Tests',
  lint: 'Lint',
  custom: 'Commande',
};

/** Grammatical gender of the label, for `Réussie` (Installation) vs `Réussi` (Build). */
const FEMININE: Record<CommandKind, boolean> = {
  install: true,
  dev: false,
  build: false,
  test: false,
  lint: false,
  custom: true,
};

export interface CommandRunSummary {
  status: CommandRunStatus;
  /** Start (running) or end time of the run. */
  at: Date | string | number;
  /** Port announced by the dev server while it runs. */
  port?: number | null;
  /** Parsed test counts, only when the runner read them from the real output. */
  passed?: number | null;
  failed?: number | null;
  total?: number | null;
}

export interface CommandRunBadge {
  label: string;
  tone: BadgeTone;
}

/**
 * `long` = D04 badge (« Réussie · il y a 2 h », « En cours · port 3000 », « 10 / 10 réussis · hier »);
 * `short` = M04 badge without time nor port (« Réussie », « En cours », « 10 / 10 »).
 */
export function commandRunBadge(
  kind: CommandKind,
  run: CommandRunSummary | null | undefined,
  now: Date | string | number = new Date(),
  variant: 'long' | 'short' = 'long',
): CommandRunBadge {
  if (!run) return { label: 'Aucun lancement', tone: 'neutral' };
  const long = variant === 'long';
  const when = long ? formatRelative(run.at, now) : null;
  const f = FEMININE[kind];
  switch (run.status) {
    case 'running':
      return {
        label: long && typeof run.port === 'number' ? joinParts('En cours', `port ${run.port}`) : 'En cours',
        tone: 'accent',
      };
    case 'succeeded':
      if (kind === 'test' && typeof run.passed === 'number' && typeof run.total === 'number') {
        const ratio = formatRatio(run.passed, run.total);
        return { label: long ? joinParts(`${ratio} réussis`, when) : ratio, tone: 'success' };
      }
      return { label: joinParts(f ? 'Réussie' : 'Réussi', when), tone: 'success' };
    case 'failed':
      if (kind === 'test' && typeof run.failed === 'number' && run.failed > 0) {
        return { label: joinParts(plural(run.failed, 'échec'), when), tone: 'danger' };
      }
      return { label: joinParts('Échec', when), tone: 'danger' };
    case 'stopped':
      return { label: joinParts(f ? 'Arrêtée' : 'Arrêté', when), tone: 'neutral' };
  }
}

/** « 10 réussis · 3,2 s » meta of a Bash tool line running tests (W3), from parsed counts. */
export function testCountsMeta(passed: number, failed: number): string {
  return failed > 0
    ? joinParts(`${formatNumber(passed)} réussis`, plural(failed, 'échec'))
    : `${formatNumber(passed)} réussis`;
}
