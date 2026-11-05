import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { formatAdditions, formatDeletions } from '../lib/format';
import { CHANGE_STATUS_LABEL, type ChangeStatus } from '../lib/git';

const CHIP: Record<ChangeStatus, string> = {
  M: 'bg-warn-pale text-warn',
  A: 'bg-success-pale text-success',
  D: 'bg-danger-pale text-danger',
  R: 'bg-accent-pale text-accent',
};

export interface ChangeStatusChipProps {
  status: ChangeStatus;
  className?: string;
}

/** 20 × 20 status square of `Dev · Fichier modifié` (`M` warn, `A` success, `D` danger, `R` accent). */
export function ChangeStatusChip({ status, className }: ChangeStatusChipProps) {
  return (
    <span
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-sm font-mono text-app-11 font-bold',
        CHIP[status],
        className,
      )}
    >
      <span aria-hidden>{status}</span>
      <span className="sr-only">{CHANGE_STATUS_LABEL[status]} :</span>
    </span>
  );
}

export interface ChangedFileRowProps {
  status: ChangeStatus;
  /** Full path (tooltip, accessible name). */
  path: string;
  /** Displayed path when shorter than the full one (W4: `crm/PipelineBoard.tsx`). */
  label?: string;
  /** Previous path of a rename. */
  oldPath?: string | null;
  additions?: number;
  deletions?: number;
  /** Binary file: no line counts. */
  binary?: boolean;
  /** The diff shown below is this file's (accent-pale background). */
  selected?: boolean;
  /** Selects the file (button row). */
  onSelect?: () => void;
  /** Or navigates to it (link row). */
  href?: string;
  /** Leading slot: the commit checkbox of W5 (`Fichier inclus`). */
  leading?: ReactNode;
  className?: string;
}

/**
 * `Dev · Fichier modifié` (203:554) — « Entrée de la liste des changements Git. Le chemin long se tronque
 * à la fin, le nom complet reste au survol et dans le diff. » Counts are omitted when zero.
 */
export function ChangedFileRow({
  status,
  path,
  label,
  oldPath,
  additions = 0,
  deletions = 0,
  binary,
  selected,
  onSelect,
  href,
  leading,
  className,
}: ChangedFileRowProps) {
  const tooltip = oldPath ? `${oldPath} → ${path}` : path;
  const content = (
    <>
      <ChangeStatusChip status={status} />
      <span className="min-w-0 flex-1 truncate text-left font-mono text-app-12 text-text" title={tooltip}>
        {label ?? path}
      </span>
      {binary ? (
        <span className="shrink-0 font-mono text-app-11 text-muted">binaire</span>
      ) : (
        <>
          {additions > 0 ? <span className="shrink-0 font-mono text-app-11 text-success">{formatAdditions(additions)}</span> : null}
          {deletions > 0 ? <span className="shrink-0 font-mono text-app-11 text-danger">{formatDeletions(deletions)}</span> : null}
        </>
      )}
    </>
  );
  const rowClass = cn(
    'flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5',
    selected ? 'bg-accent-pale' : (onSelect || href) && 'transition-colors duration-(--dur-fast) hover:bg-hover',
  );

  const interactive = onSelect ? (
    <button type="button" onClick={onSelect} aria-current={selected || undefined} className={cn(rowClass, 'text-left')}>
      {content}
    </button>
  ) : href ? (
    <Link href={href} aria-current={selected || undefined} className={rowClass}>
      {content}
    </Link>
  ) : (
    <div className={rowClass}>{content}</div>
  );

  if (!leading) return <div className={cn('w-full min-w-0', className)}>{interactive}</div>;
  return (
    <div className={cn('flex w-full min-w-0 items-center gap-2', className)}>
      {leading}
      <div className="min-w-0 flex-1">{interactive}</div>
    </div>
  );
}
