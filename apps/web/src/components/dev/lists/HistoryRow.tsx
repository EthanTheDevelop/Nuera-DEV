import Link from 'next/link';
import { formatDuration } from '@nuera/shared/format';
import { Icon } from '@/components/icons';
import { Badge, SectionLabel } from '@/components/ui';
import { cn } from '@/lib/cn';
import { joinParts, SEP } from '../lib/format';
import { historyStatusMeta, type SessionStatus } from '../lib/session-status';
import { LiveTime, type DateInput } from '../status/LiveTime';
import { ACTION_VARIANT, RowActionButton, type RowAction } from './row-action';

/** Column template shared by `HistoryTableHeader` and the rows (D06 `Tableau de l'historique`). */
export const HISTORY_TABLE_GRID =
  'grid grid-cols-[minmax(0,1fr)_140px_170px_160px_200px_120px] items-center gap-4';

/** D06 header: `SESSION · PROJET · BRANCHE · DÉBUT · DURÉE · STATUT · ACTION`. */
export function HistoryTableHeader({ className }: { className?: string }) {
  return (
    <div className={cn(HISTORY_TABLE_GRID, 'border-b border-border py-2.5', className)}>
      <SectionLabel as="span">Session</SectionLabel>
      <SectionLabel as="span">Projet</SectionLabel>
      <SectionLabel as="span">Branche</SectionLabel>
      <SectionLabel as="span">Début · durée</SectionLabel>
      <SectionLabel as="span">Statut</SectionLabel>
      <SectionLabel as="span" className="text-right">
        Action
      </SectionLabel>
    </div>
  );
}

export interface HistoryRowProps {
  title: string;
  projectName: string;
  branch?: string | null;
  status: SessionStatus;
  /** Worktree present and conversation saved (« Interrompue · reprise possible »). */
  resumable: boolean;
  startedAt: DateInput;
  durationMs?: number | null;
  /**
   * Row action (table). Label and style default from the status: Voir le résumé, Reprendre, Voir,
   * Pourquoi ? — without `href`/`onClick` nothing is drawn.
   */
  action?: Partial<RowAction> | null;
  /** Phone list: the whole row opens the session (summary, replay or resume). */
  href?: string;
  /** `table` = D06 `Dev · Ligne d'historique` (215:1791) · `list` = M06 two-line row. */
  variant?: 'table' | 'list';
  /**
   * Replaces the status badge (warn) while something stops the session that its status does not
   * say: the usage limit (« Limite atteinte · reprise à 15 h 02 »).
   */
  statusNote?: string | null;
  className?: string;
}

/**
 * `Dev · Ligne d'historique` (215:1791) — « Ligne de l'historique des sessions : nom, projet, branche,
 * date, durée, statut de reprise, action. »
 */
export function HistoryRow({
  title,
  projectName,
  branch,
  status,
  resumable,
  startedAt,
  durationMs,
  action,
  href,
  variant = 'table',
  statusNote,
  className,
}: HistoryRowProps) {
  const meta = historyStatusMeta(status, resumable);
  const badge = statusNote ? { tone: 'warn' as const, label: statusNote, shortLabel: statusNote } : meta;
  const duration = typeof durationMs === 'number' ? formatDuration(durationMs) : null;

  if (variant === 'list') {
    return (
      <div
        className={cn(
          'relative flex min-w-0 items-center gap-2.5 border-b border-border py-3 last:border-b-0',
          href && 'transition-colors duration-(--dur-fast) hover:bg-hover',
          className,
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          {href ? (
            <Link
              href={href}
              className="truncate font-sans text-app-15 font-semibold text-text after:absolute after:inset-0 after:content-['']"
            >
              {title}
            </Link>
          ) : (
            <p className="m-0 truncate font-sans text-app-15 font-semibold text-text">{title}</p>
          )}
          <span className="truncate font-mono text-app-11 text-muted">{joinParts(projectName, branch)}</span>
          <div className="flex min-w-0 items-center gap-2">
            <Badge tone={badge.tone}>{badge.shortLabel}</Badge>
            <span className="truncate font-sans text-app-12 text-muted">
              <LiveTime value={startedAt} format="day" />
              {duration ? `${SEP}${duration}` : null}
            </span>
          </div>
        </div>
        {href ? <Icon name="chevron" size={18} className="text-muted" /> : null}
      </div>
    );
  }

  const resolved: RowAction | null =
    action && (action.href || action.onClick || action.disabled)
      ? {
          ...action,
          label: action.label ?? meta.action.label,
          variant: action.variant ?? ACTION_VARIANT[meta.action.variant],
        }
      : null;

  return (
    <div className={cn(HISTORY_TABLE_GRID, 'border-b border-border py-3 last:border-b-0', className)}>
      <div className="flex min-w-0 items-center gap-2.5">
        <Icon name="terminal" size={16} className="text-muted" />
        <p className="m-0 min-w-0 flex-1 truncate font-sans text-app-14 font-semibold text-text" title={title}>
          {title}
        </p>
      </div>
      <p className="m-0 min-w-0 truncate font-sans text-app-13 text-text">{projectName}</p>
      <div className="flex min-w-0 items-center gap-1.5">
        {branch ? (
          <>
            <Icon name="git-branch" size={13} className="text-muted" />
            <span className="truncate font-mono text-app-11 text-muted" title={branch}>
              {branch}
            </span>
          </>
        ) : null}
      </div>
      <p className="m-0 min-w-0 truncate font-sans text-app-13 text-muted">
        <LiveTime value={startedAt} format="datetime" />
        {duration ? `${SEP}${duration}` : null}
      </p>
      <div className="flex min-w-0">
        <Badge tone={badge.tone} title={statusNote ?? undefined}>{badge.label}</Badge>
      </div>
      <div className="flex min-w-0 justify-end">{resolved ? <RowActionButton action={resolved} /> : null}</div>
    </div>
  );
}
