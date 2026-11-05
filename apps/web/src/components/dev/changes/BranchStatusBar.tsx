import type { ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { BadgeTone } from '../lib/tones';

export interface BranchStatusBarProps {
  branch: string;
  /** Status sentence (see `describeBranchStatus`): « 2 commits d'avance · 4 fichiers non commités ». */
  status?: string | null;
  /** S3 card variant: a badge instead of the sentence (« 2 en avance »). */
  badge?: { label: string; tone: BadgeTone } | null;
  /** Buttons row (« Préparer le commit », « Préparer la pull request »). */
  actions?: ReactNode;
  /**
   * Nothing to commit (W1): pass the buttons `disabled` (each one is then drawn at 40 %, as the
   * Figma group); this flag marks the group `aria-disabled`. The status sentence carries the reason
   * (« aucune modification »).
   */
  actionsDisabled?: boolean;
  /** `panel` = D05 `Actions Git` (top border, pinned) · `card` = S3 `Branche` card. */
  variant?: 'panel' | 'card';
  className?: string;
}

/** D05 `Actions Git` (214:1850) / S3 `Branche`: branch, ahead/uncommitted summary and Git actions. */
export function BranchStatusBar({
  branch,
  status,
  badge,
  actions,
  actionsDisabled,
  variant = 'panel',
  className,
}: BranchStatusBarProps) {
  if (variant === 'card') {
    return (
      <div className={cn('flex w-full min-w-0 flex-col gap-3', className)}>
        <div className="flex min-h-11 items-center gap-2 rounded-md border border-border bg-bg px-3 py-2.5">
          <Icon name="git-branch" size={16} className="text-text" />
          <p className="m-0 min-w-0 flex-1 truncate font-mono text-app-13 font-medium text-text" title={branch}>
            {branch}
          </p>
          {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
          {!badge && status ? <span className="shrink-0 truncate font-sans text-app-12 text-muted">{status}</span> : null}
        </div>
        {actions ? (
          <div className="flex flex-col gap-2" aria-disabled={actionsDisabled || undefined}>
            {actions}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-2.5 border-t border-border bg-bg px-4 py-3.5', className)}>
      <div className="flex min-w-0 items-center gap-2">
        <Icon name="git-branch" size={16} className="text-text" />
        <p className="m-0 max-w-[60%] shrink-0 truncate font-mono text-app-12 font-medium text-text" title={branch}>
          {branch}
        </p>
        {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
        {status ? <p className="m-0 min-w-0 flex-1 truncate font-sans text-app-12 text-muted">{status}</p> : null}
      </div>
      {actions ? (
        <div
          className="flex flex-wrap items-center gap-2"
          aria-disabled={actionsDisabled || undefined}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
