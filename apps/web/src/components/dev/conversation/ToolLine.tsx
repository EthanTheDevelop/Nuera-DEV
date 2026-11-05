'use client';

import { useId, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@/components/icons';
import { cn } from '@/lib/cn';
import { LiveTime, type DateInput } from '../status/LiveTime';

export type ToolLineStatus = 'done' | 'running' | 'error' | 'denied';

const STATUS: Record<ToolLineStatus, { icon: IconName; iconClass: string; label: string }> = {
  done: { icon: 'check', iconClass: 'text-success', label: 'Terminé' },
  running: { icon: 'clock', iconClass: 'text-en-cours', label: 'En cours' },
  error: { icon: 'alert', iconClass: 'text-danger', label: 'Erreur' },
  denied: { icon: 'x', iconClass: 'text-muted', label: 'Refusé' },
};

export interface ToolLineProps {
  /** Tool name as reported by the CLI (`Read`, `Edit`, `Write`, `Bash`, `Glob`, `mcp__figma__…`). */
  tool: string;
  /** Path, pattern or command the tool acted on. */
  target?: string | null;
  status: ToolLineStatus;
  /**
   * Result summary: `212 lignes`, `14 fichiers`, `+46 −12` (see `formatLineDelta`), `code 1 · 2 échecs`.
   * Defaults: `en cours · 38 s` (running, needs `startedAt`), `refusé` (denied).
   */
  meta?: string | null;
  /** Start of a running tool, for the live `en cours · 38 s`. */
  startedAt?: DateInput | null;
  /** Expandable detail (usually a `CommandOutput`). Without it the line is static, without chevron. */
  children?: ReactNode;
  /** Controlled expansion. */
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
}

/**
 * `Dev · Ligne d'outil` (203:369) — « Une action de Claude Code (Read, Edit, Write, Bash, Glob…),
 * repliée. Le chevron déplie sa sortie (Dev · Sortie de commande). »
 */
export function ToolLine({
  tool,
  target,
  status,
  meta,
  startedAt,
  children,
  expanded: controlled,
  defaultExpanded = false,
  onExpandedChange,
  className,
}: ToolLineProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultExpanded);
  const expanded = controlled ?? uncontrolled;
  const detailId = useId();
  const expandable = children !== undefined && children !== null && children !== false;
  const spec = STATUS[status];

  const toggle = () => {
    const next = !expanded;
    if (controlled === undefined) setUncontrolled(next);
    onExpandedChange?.(next);
  };

  // An empty summary (e.g. `formatLineDelta(0, 0)`) is no summary: no empty cell in the row.
  let metaNode: ReactNode = meta ? meta : null;
  if (metaNode === null && status === 'running' && startedAt !== undefined && startedAt !== null) {
    metaNode = <LiveTime value={startedAt} format="elapsed" prefix="en cours · " />;
  } else if (metaNode === null && status === 'running') {
    metaNode = 'en cours';
  } else if (metaNode === null && status === 'denied') {
    metaNode = 'refusé';
  }

  const row = (
    <>
      <Icon name={spec.icon} size={16} className={spec.iconClass} />
      <span className="sr-only">{spec.label} :</span>
      <span className="shrink-0 font-mono text-app-12 font-medium whitespace-nowrap text-text">{tool}</span>
      <span className="min-w-0 flex-1 truncate text-left font-mono text-app-12 text-muted" title={target ?? undefined}>
        {target}
      </span>
      {metaNode !== null ? (
        <span
          className={cn('shrink-0 font-mono text-app-11 whitespace-nowrap', status === 'error' ? 'text-danger' : 'text-muted')}
        >
          {metaNode}
        </span>
      ) : null}
      {expandable ? (
        <Icon
          name="chevron"
          size={14}
          className={cn('text-muted transition-transform duration-(--dur-fast) ease-out', expanded && 'rotate-90')}
        />
      ) : null}
    </>
  );

  const rowClass = cn(
    'flex min-h-[34px] w-full min-w-0 items-center gap-2.5 rounded-md border bg-bg px-3 py-2',
    status === 'error' ? 'border-danger' : 'border-border',
  );

  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-3.5', className)}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={toggle}
          // 34 px row, 44 px hit area (thread rows are 8 px apart on the phone).
          className={cn(rowClass, 'nu-hit text-left transition-colors duration-(--dur-fast) hover:bg-hover')}
        >
          {row}
        </button>
      ) : (
        <div className={rowClass}>{row}</div>
      )}
      {expandable ? (
        <div id={detailId} hidden={!expanded} className="min-w-0">
          {expanded ? children : null}
        </div>
      ) : null}
    </div>
  );
}
