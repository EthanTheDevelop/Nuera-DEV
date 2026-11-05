/**
 * Git status copy: branch line of the Workspace (`Actions Git`, D05 / W1 / W2), project sync badges
 * (D01, D02, M01, M02, D04) and change-status chips (`Dev · Fichier modifié`, 203:554).
 */
import type { SyncState } from '@nuera/db';
import { formatNumber, plural } from '@nuera/shared/format';
import { joinParts } from './format';
import type { BadgeTone } from './tones';

export type { SyncState };

export interface BranchStatusInput {
  /** Commits ahead of the base (or upstream). */
  ahead?: number | null;
  /** Commits behind the base (or upstream). */
  behind?: number | null;
  /** Files with uncommitted changes in the worktree. */
  uncommitted?: number | null;
  /** Base branch name (`main`) used for « à jour avec main ». */
  base?: string | null;
}

/**
 * `2 commits d'avance · 4 fichiers non commités` (D05), `à jour avec main · aucune modification` (W1).
 * Unknown counts (null: git could not be read, runner `WorktreeDto`) are never shown as « à jour ».
 */
export function describeBranchStatus({ ahead, behind, uncommitted, base }: BranchStatusInput): string {
  const parts: string[] = [];
  if (ahead && ahead > 0) parts.push(`${plural(ahead, 'commit')} d'avance`);
  if (behind && behind > 0) parts.push(`${plural(behind, 'commit')} de retard`);
  if (ahead === 0 && behind === 0 && base) parts.push(`à jour avec ${base}`);
  if (uncommitted && uncommitted > 0) parts.push(`${plural(uncommitted, 'fichier')} non ${uncommitted >= 2 ? 'commités' : 'commité'}`);
  else if (typeof uncommitted === 'number') parts.push('aucune modification');
  return joinParts(...parts);
}

export interface SyncBadgeInput {
  state: SyncState;
  ahead?: number | null;
  behind?: number | null;
  /** A fetch / pull operation is running (`Synchronisation…`). */
  syncing?: boolean;
  /** The last pull stopped on a conflict (`Conflit à résoudre`). */
  conflict?: boolean;
}

export interface SyncBadge {
  label: string;
  tone: BadgeTone;
}

/**
 * Project sync badge. `long` = D02 table (`2 commits en retard`, `Conflit à résoudre`),
 * `short` = dashboard and phone (`2 en retard`, `Conflit`).
 */
export function syncBadge(input: SyncBadgeInput, variant: 'long' | 'short' = 'long'): SyncBadge {
  if (input.syncing) return { label: 'Synchronisation…', tone: 'accent' };
  if (input.conflict) return { label: variant === 'long' ? 'Conflit à résoudre' : 'Conflit', tone: 'danger' };
  const behind = input.behind ?? 0;
  const ahead = input.ahead ?? 0;
  switch (input.state) {
    case 'up_to_date':
      return { label: 'À jour', tone: 'success' };
    case 'behind':
      return {
        label: variant === 'long' ? `${plural(behind, 'commit')} en retard` : `${formatNumber(behind)} en retard`,
        tone: 'warn',
      };
    case 'ahead':
      return {
        label: variant === 'long' ? `${plural(ahead, 'commit')} d'avance` : `${formatNumber(ahead)} en avance`,
        tone: 'accent',
      };
    case 'diverged':
      return {
        label:
          variant === 'long'
            ? joinParts(`${formatNumber(ahead)} d'avance`, `${formatNumber(behind)} en retard`)
            : 'Divergente',
        tone: 'warn',
      };
    case 'no_upstream':
      return { label: variant === 'long' ? 'Sans branche distante' : 'Locale', tone: 'neutral' };
    case 'unknown':
      return { label: variant === 'long' ? 'État inconnu' : 'Inconnu', tone: 'neutral' };
  }
}

/** Git change status as shown by the status chip (`M`, `A`, `D`, `R`). */
export type ChangeStatus = 'M' | 'A' | 'D' | 'R';

export const CHANGE_STATUS_LABEL: Record<ChangeStatus, string> = {
  M: 'Modifié',
  A: 'Ajouté',
  D: 'Supprimé',
  R: 'Renommé',
};

/** Maps a porcelain status letter (`M`, `A`, `D`, `R`, `C`, `T`, `U`, `?`) to a chip. */
export function toChangeStatus(letter: string): ChangeStatus {
  switch (letter.toUpperCase()) {
    case 'A':
    case '?':
    case 'C':
      return 'A';
    case 'D':
      return 'D';
    case 'R':
      return 'R';
    default:
      return 'M';
  }
}
