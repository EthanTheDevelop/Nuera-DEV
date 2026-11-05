import Link from 'next/link';
import { plural } from '@nuera/shared/format';
import { Icon } from '@/components/icons';
import { Pastille, SectionLabel, StatusDot } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatRatio, joinParts } from '../lib/format';
import { sessionStatusMeta, type SessionStatus } from '../lib/session-status';
import type { DateInput } from '../status/LiveTime';
import { SessionStatusBadge } from '../status/SessionStatusBadge';

export type SessionSwitcherVariant = 'popover' | 'sheet';

export interface SessionSwitcherHeaderProps {
  projectName: string;
  /** Live sessions of the project / parallel sessions allowed (`2 / 4`). */
  active: number;
  max?: number | null;
  variant?: SessionSwitcherVariant;
  className?: string;
}

/**
 * W6 popover head (`NUERA OS · 2 SESSIONS ACTIVES` · `2 / 4`) or S4 sheet title
 * (`Sessions de Nuera OS` · `2 / 4`).
 */
export function SessionSwitcherHeader({ projectName, active, max, variant = 'popover', className }: SessionSwitcherHeaderProps) {
  const ratio = typeof max === 'number' ? formatRatio(active, max) : null;
  if (variant === 'sheet') {
    return (
      <div className={cn('flex items-center gap-2 pt-1 pb-2', className)}>
        <h2 className="m-0 min-w-0 flex-1 truncate font-sans text-app-18 font-semibold text-text">{`Sessions de ${projectName}`}</h2>
        {ratio ? (
          <span className="shrink-0 font-mono text-app-12 text-muted" title="Sessions actives / sessions parallèles autorisées">
            {ratio}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <SectionLabel
      as="p"
      className={cn('px-2.5 py-2', className)}
      action={
        ratio ? (
          <span className="shrink-0 font-mono text-app-11 text-muted" title="Sessions actives / sessions parallèles autorisées">
            {ratio}
          </span>
        ) : undefined
      }
    >
      {joinParts(projectName, plural(active, 'session active', 'sessions actives'))}
    </SectionLabel>
  );
}

export interface SessionSwitcherItemProps {
  title: string;
  status: SessionStatus;
  branch?: string | null;
  worktreeName?: string | null;
  /** Live sessions: start → « En cours · 7 min » (popover). */
  since?: DateInput | null;
  durationMs?: number | null;
  /** The session shown in the Workspace (accent-pale row, « · affichée »). */
  current?: boolean;
  /** Switches the Workspace to this session. */
  href?: string;
  onSelect?: () => void;
  variant?: SessionSwitcherVariant;
  className?: string;
}

/** W6 / S4 session row: dot · title (+ « · affichée ») / worktree line · status badge. */
export function SessionSwitcherItem({
  title,
  status,
  branch,
  worktreeName,
  since,
  durationMs,
  current,
  href,
  onSelect,
  variant = 'popover',
  className,
}: SessionSwitcherItemProps) {
  const sheet = variant === 'sheet';
  const meta = sessionStatusMeta(status);
  const worktreeLine = joinParts(branch, worktreeName ? `worktree ${worktreeName}` : null);
  const classes = cn(
    'flex w-full min-w-0 items-center text-left',
    sheet ? 'min-h-16 gap-3 rounded-md p-3' : 'gap-2.5 rounded-sm p-2.5',
    current ? 'bg-accent-pale' : (href || onSelect) && 'transition-colors duration-(--dur-fast) hover:bg-hover',
    className,
  );
  const content = (
    <>
      <StatusDot tone={meta.dot} />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={cn('truncate font-sans font-semibold text-text', sheet ? 'text-app-15' : 'text-app-14')}>{title}</span>
          {current && !sheet ? <span className="shrink-0 font-sans text-app-12 text-muted">· affichée</span> : null}
        </span>
        {worktreeLine ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon name="worktree" size={13} className="text-muted" />
            <span className="truncate font-mono text-app-11 text-muted">{worktreeLine}</span>
          </span>
        ) : null}
      </span>
      <SessionStatusBadge
        status={status}
        since={sheet ? null : since}
        durationMs={sheet ? null : durationMs}
        short={sheet}
      />
    </>
  );
  if (current) {
    return (
      <div aria-current="true" className={classes}>
        {content}
      </div>
    );
  }
  if (href) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }
  if (onSelect) {
    return (
      <button type="button" onClick={onSelect} className={classes}>
        {content}
      </button>
    );
  }
  return <div className={classes}>{content}</div>;
}

export interface SessionSwitcherNewItemProps {
  href?: string;
  onClick?: () => void;
  /** Popover caption: « Créé depuis main · 10,9 Go de mémoire libre ». */
  description?: string | null;
  /** Capacity reached (`4 / 4`) or not enough memory: disabled with the reason. */
  disabledReason?: string | null;
  variant?: SessionSwitcherVariant;
  className?: string;
}

/** « Nouvelle session dans un nouveau worktree » (W6) / « Nouvelle session dans un worktree » (S4). */
export function SessionSwitcherNewItem({
  href,
  onClick,
  description,
  disabledReason,
  variant = 'popover',
  className,
}: SessionSwitcherNewItemProps) {
  const sheet = variant === 'sheet';
  const disabled = Boolean(disabledReason) || (!href && !onClick);
  const label = sheet ? 'Nouvelle session dans un worktree' : 'Nouvelle session dans un nouveau worktree';
  const caption = disabledReason ?? (sheet ? null : description);
  const classes = cn(
    'flex w-full min-w-0 items-center text-left',
    sheet ? 'min-h-14 gap-3 rounded-md p-3' : 'gap-2.5 rounded-sm p-2.5',
    disabled ? 'cursor-not-allowed' : 'transition-colors duration-(--dur-fast) hover:bg-hover',
    className,
  );
  const content = (
    <>
      <Pastille
        icon="plus"
        size={28}
        shape="circle"
        className={cn(!sheet && 'size-6 [&_svg]:size-3.5', disabled && 'opacity-40')}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn('font-sans font-medium text-accent', sheet ? 'text-app-15' : 'text-app-14', disabled && 'opacity-40')}
        >
          {label}
        </span>
        {caption ? <span className="font-sans text-app-12 text-muted">{caption}</span> : null}
      </span>
    </>
  );
  if (disabled) {
    return (
      <div aria-disabled className={classes}>
        {content}
      </div>
    );
  }
  if (href) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={classes}>
      {content}
    </button>
  );
}

/** W6 note (verbatim). */
export function SessionSwitcherNote({ className }: { className?: string }) {
  return (
    <p className={cn('m-0 px-2.5 pt-1 pb-1.5 font-sans text-app-12 text-muted', className)}>
      Chaque session a son worktree : passer de l&apos;une à l&apos;autre ne déplace aucun fichier.
    </p>
  );
}

/** S4 last row: « Toutes les sessions » › (`/sessions`). */
export function SessionSwitcherAllLink({ href, className }: { href: string; className?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        'flex min-h-[52px] w-full items-center gap-2 border-t border-border p-3 transition-colors duration-(--dur-fast) hover:bg-hover',
        className,
      )}
    >
      <span className="min-w-0 flex-1 font-sans text-app-15 text-text">Toutes les sessions</span>
      <Icon name="chevron" size={18} className="text-muted" />
    </Link>
  );
}
