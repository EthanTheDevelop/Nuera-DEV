import { Icon } from '@/components/icons';
import { Card, StatusDot } from '@/components/ui';
import { cn } from '@/lib/cn';
import { joinParts } from '../lib/format';
import { defaultSessionAction, sessionStatusMeta, type SessionStatus } from '../lib/session-status';
import { TONE_TEXT } from '../lib/tones';
import { LiveTime, type DateInput } from '../status/LiveTime';
import { ACTION_VARIANT, RowActionButton, type RowAction } from './row-action';

/** Corner time of the card: elapsed while live (« 12 min »), else when it ended (« hier », « lun. »). */
export type SessionCardTime = { kind: 'elapsed'; since: DateInput } | { kind: 'at'; date: DateInput };

export interface SessionCardProps {
  status: SessionStatus;
  title: string;
  projectName: string;
  branch?: string | null;
  worktreeName?: string | null;
  time?: SessionCardTime | null;
  /** Current / last activity (`currentActivity`), at most two lines. */
  activity?: string | null;
  /**
   * The card's single action. Label and style default from the status (Ouvrir, Répondre, Voir le
   * résumé, Reprendre); without `href`/`onClick` no button is drawn.
   */
  action?: Partial<RowAction> | null;
  /** Interrupted / stopped sessions: worktree present and conversation saved. */
  resumable?: boolean;
  className?: string;
}

/**
 * `Dev · Carte de session` (203:655) — « Session Claude Code vue de l'extérieur : statut, projet, branche
 * et worktree, dernière activité, action principale. Tuile Nuera OS (rayon xl, Shadow/Soft). »
 * 320 px on desktop grids, 290 px in phone rails (width set by the parent).
 */
export function SessionCard({
  status,
  title,
  projectName,
  branch,
  worktreeName,
  time,
  activity,
  action,
  resumable,
  className,
}: SessionCardProps) {
  const meta = sessionStatusMeta(status);
  const preset = defaultSessionAction(status, resumable);
  const resolved: RowAction | null =
    action && (action.href || action.onClick || action.disabled)
      ? { ...action, label: action.label ?? preset.label, variant: action.variant ?? ACTION_VARIANT[preset.variant] }
      : null;
  const branchLine = joinParts(branch, worktreeName ? `worktree ${worktreeName}` : null);

  return (
    <Card variant="tile" as="article" aria-label={title} className={cn('gap-2.5', className)}>
      <div className="flex items-center gap-2">
        <StatusDot tone={meta.dot} />
        <p className={cn('m-0 min-w-0 flex-1 truncate font-sans text-app-12 font-medium', TONE_TEXT[meta.cardLabel])}>
          {meta.label}
        </p>
        {time ? (
          <LiveTime
            value={time.kind === 'elapsed' ? time.since : time.date}
            format={time.kind === 'elapsed' ? 'elapsed' : 'age'}
            className="shrink-0 font-mono text-app-11 text-muted"
          />
        ) : null}
      </div>
      <h3 className="m-0 truncate font-sans text-app-16 font-semibold text-text" title={title}>
        {title}
      </h3>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="m-0 flex min-w-0 items-center gap-1.5">
          <Icon name="projets" size={14} className="text-muted" />
          <span className="min-w-0 flex-1 truncate font-sans text-app-12 text-muted">{projectName}</span>
        </p>
        {branchLine ? (
          <p className="m-0 flex min-w-0 items-center gap-1.5">
            <Icon name="worktree" size={14} className="text-muted" />
            <span className="min-w-0 flex-1 truncate font-mono text-app-11 text-muted" title={branchLine}>
              {branchLine}
            </span>
          </p>
        ) : null}
      </div>
      {activity ? (
        <p className="m-0 line-clamp-2 font-sans text-app-13 leading-[18px] text-text">{activity}</p>
      ) : null}
      {resolved ? (
        <div className="flex">
          <RowActionButton action={resolved} />
        </div>
      ) : null}
    </Card>
  );
}
