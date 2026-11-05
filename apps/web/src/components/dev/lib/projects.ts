/**
 * Sessions column of the project library (D02 `Colonne sessions`, M02 status line):
 * `2 actives` (En cours), `1 interrompue` (Danger), `1 terminée` (Succès), `aucune` (Neutre).
 */
import { formatNumber } from '@nuera/shared/format';
import type { DotTone } from './tones';

export interface ProjectSessionsInput {
  /** Sessions with a live CLI process. */
  active: number;
  /** Ended sessions that can be resumed or need attention. */
  interrupted?: number;
  finished?: number;
}

export interface ProjectSessionsSummary {
  tone: DotTone;
  label: string;
}

export function projectSessionsSummary({ active, interrupted = 0, finished = 0 }: ProjectSessionsInput): ProjectSessionsSummary {
  if (active > 0) return { tone: 'running', label: `${formatNumber(active)} ${active >= 2 ? 'actives' : 'active'}` };
  if (interrupted > 0) {
    return { tone: 'danger', label: `${formatNumber(interrupted)} ${interrupted >= 2 ? 'interrompues' : 'interrompue'}` };
  }
  if (finished > 0) return { tone: 'success', label: `${formatNumber(finished)} ${finished >= 2 ? 'terminées' : 'terminée'}` };
  return { tone: 'neutral', label: 'aucune' };
}
