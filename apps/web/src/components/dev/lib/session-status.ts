/**
 * Presentation of `sessions.status` (packages/db/src/schema/types.ts) in every composite:
 * card label + dot, header/switcher badge, history badge and the default primary action.
 *
 * Figma sources: `Dev · Carte de session` (203:655), D05/W1–W7 header badges, W6 switcher, S4 sheet,
 * D06 history (`Dev · Ligne d'historique`, 215:1791) and M06 (short history labels).
 */
import type { SessionStatus } from '@nuera/db';
import { formatDuration } from '@nuera/shared/format';
import { joinParts } from './format';
import type { BadgeTone, DotTone } from './tones';

export type { SessionStatus };

export interface SessionStatusMeta {
  /** Full label (`Autorisation demandée`). */
  label: string;
  /** Short label for narrow rows (S4 sheet: `Autorisation`). */
  shortLabel: string;
  /** Badge tone (header, switcher, sheet). */
  badge: BadgeTone;
  /** Status dot tone (cards, switcher rows). */
  dot: DotTone;
  /**
   * Colour of the label next to the dot on `Dev · Carte de session`. Figma draws `En cours` in `warn`
   * next to an `en-cours` dot (as designed, see states-mobile-and-extensions.md §8.8).
   */
  cardLabel: DotTone;
  /** Whether a CLI process is alive (Interrompre available, counts in capacity). */
  live: boolean;
}

const META: Record<SessionStatus, SessionStatusMeta> = {
  new: { label: 'Prête', shortLabel: 'Prête', badge: 'neutral', dot: 'neutral', cardLabel: 'neutral', live: false },
  running: { label: 'En cours', shortLabel: 'En cours', badge: 'accent', dot: 'running', cardLabel: 'warn', live: true },
  waiting_permission: {
    label: 'Autorisation demandée',
    shortLabel: 'Autorisation',
    badge: 'warn',
    dot: 'warn',
    cardLabel: 'warn',
    live: true,
  },
  // Turn finished, the CLI process is alive and waits for the next instruction (not drawn in Figma:
  // uses the `Accent` tone that exists in `Dev · Point de statut` but no frame uses).
  waiting_input: {
    label: "En attente d'instruction",
    shortLabel: 'En attente',
    badge: 'accent',
    dot: 'accent',
    cardLabel: 'accent',
    live: true,
  },
  stopped: { label: 'Arrêtée', shortLabel: 'Arrêtée', badge: 'neutral', dot: 'neutral', cardLabel: 'neutral', live: false },
  interrupted: {
    label: 'Interrompue',
    shortLabel: 'Interrompue',
    badge: 'danger',
    dot: 'danger',
    cardLabel: 'danger',
    live: false,
  },
  failed: { label: 'En échec', shortLabel: 'Échec', badge: 'danger', dot: 'danger', cardLabel: 'danger', live: false },
  finished: { label: 'Terminée', shortLabel: 'Terminée', badge: 'success', dot: 'success', cardLabel: 'success', live: false },
  archived: { label: 'Archivée', shortLabel: 'Archivée', badge: 'neutral', dot: 'neutral', cardLabel: 'neutral', live: false },
};

export function sessionStatusMeta(status: SessionStatus): SessionStatusMeta {
  return META[status];
}

/**
 * The CLI shows an interactive screen (login, trust, menu…) that waits for an answer in its
 * terminal (`SessionDto.attention`, runner screen detection). Not drawn in Figma: Alerte tone, like
 * « Autorisation demandée », since the owner has to act.
 */
export const ATTENTION_STATUS_META: SessionStatusMeta = {
  label: 'Attend une réponse',
  shortLabel: 'Attend une réponse',
  badge: 'warn',
  dot: 'warn',
  cardLabel: 'warn',
  live: true,
};

/** Status shown for a session: « Attend une réponse » wins over the stored status while the CLI waits. */
export function sessionDisplayMeta(status: SessionStatus, attention?: boolean): SessionStatusMeta {
  return attention && status !== 'archived' ? ATTENTION_STATUS_META : META[status];
}

/**
 * Header / switcher badge label: `En cours · 7 min`, `Terminée · 18 min`, `Autorisation demandée`.
 * `durationMs` = elapsed time while live, total duration once ended (W2, W3, W6).
 */
export function sessionBadgeLabel(
  status: SessionStatus,
  durationMs?: number | null,
  options: { short?: boolean } = {},
): string {
  const meta = META[status];
  const label = options.short ? meta.shortLabel : meta.label;
  const withDuration = status === 'running' || status === 'finished';
  return withDuration && typeof durationMs === 'number' && durationMs >= 0
    ? joinParts(label, formatDuration(durationMs))
    : label;
}

export type SessionActionVariant = 'primary' | 'secondary' | 'quiet';

export interface SessionActionPreset {
  label: string;
  variant: SessionActionVariant;
}

/**
 * Default primary action of a session card (`Dev · Carte de session`): one action per card,
 * Principal only when the session waits for the owner.
 */
export function defaultSessionAction(status: SessionStatus, resumable = false, attention = false): SessionActionPreset {
  if (attention && META[status].live !== false && status !== 'archived') return { label: 'Répondre', variant: 'primary' };
  switch (status) {
    case 'waiting_permission':
      return { label: 'Répondre', variant: 'primary' };
    case 'finished':
      return { label: 'Voir le résumé', variant: 'secondary' };
    case 'interrupted':
    case 'stopped':
    case 'failed':
      return resumable ? { label: 'Reprendre', variant: 'secondary' } : { label: 'Voir', variant: 'secondary' };
    case 'archived':
      return { label: 'Voir', variant: 'secondary' };
    default:
      return { label: 'Ouvrir', variant: 'secondary' };
  }
}

export interface HistoryStatusMeta {
  label: string;
  shortLabel: string;
  tone: BadgeTone;
  action: SessionActionPreset;
}

/**
 * History row (D06 table, M06 list). « Reprise possible » is computed (worktree present and
 * conversation saved — docs/ARCHITECTURE.md §5), hence the `resumable` flag.
 */
export function historyStatusMeta(status: SessionStatus, resumable: boolean): HistoryStatusMeta {
  if (status === 'archived') {
    return { label: 'Archivée', shortLabel: 'Archivée', tone: 'neutral', action: { label: 'Voir', variant: 'quiet' } };
  }
  if (status === 'finished') {
    return {
      label: 'Terminée',
      shortLabel: 'Terminée',
      tone: 'success',
      action: { label: 'Voir le résumé', variant: 'quiet' },
    };
  }
  if (status === 'interrupted' || status === 'stopped' || status === 'failed') {
    if (!resumable) {
      return {
        label: 'Reprise impossible',
        shortLabel: 'Reprise impossible',
        tone: 'danger',
        action: { label: 'Pourquoi ?', variant: 'quiet' },
      };
    }
    const label = status === 'stopped' ? 'Arrêtée' : status === 'failed' ? 'En échec' : 'Interrompue';
    return {
      label: joinParts(label, 'reprise possible'),
      shortLabel: 'Reprise possible',
      tone: 'warn',
      action: { label: 'Reprendre', variant: 'secondary' },
    };
  }
  // Live or not-started sessions can also appear in a history list.
  const meta = META[status];
  return { label: meta.label, shortLabel: meta.shortLabel, tone: meta.badge, action: { label: 'Ouvrir', variant: 'quiet' } };
}

/** Priority used for a project-level summary dot (W6 « most urgent wins », Q3). */
const URGENCY: Record<SessionStatus, number> = {
  waiting_permission: 6,
  running: 5,
  waiting_input: 4,
  interrupted: 3,
  failed: 3,
  new: 2,
  finished: 1,
  stopped: 0,
  archived: -1,
};

/** Most urgent status among a project's sessions (Alerte > En cours > … > Neutre). */
export function mostUrgentStatus(statuses: readonly SessionStatus[]): SessionStatus | null {
  let best: SessionStatus | null = null;
  for (const s of statuses) if (best === null || URGENCY[s] > URGENCY[best]) best = s;
  return best;
}
