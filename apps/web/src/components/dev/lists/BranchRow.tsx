import type { ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { Badge, type BadgeTone } from '@/components/ui';
import { cn } from '@/lib/cn';

export type BranchBadgeKind = 'current' | 'session' | 'protected' | 'merged';

const BADGE: Record<BranchBadgeKind, { label: string; tone: BadgeTone }> = {
  current: { label: 'Courante', tone: 'accent' },
  session: { label: 'Session active', tone: 'warn' },
  protected: { label: 'Protégée', tone: 'neutral' },
  merged: { label: 'Fusionnée', tone: 'success' },
};

export interface BranchRowProps {
  name: string;
  /** « worktree crm-core · 2 commits d'avance sur main », « branche protégée · à jour avec origin »… */
  detail?: string | null;
  /** One badge per row, most relevant first (Courante > Session active > Protégée > Fusionnée). */
  badge?: BranchBadgeKind | null;
  /** Protected branch: lock icon instead of the branch glyph. */
  protectedBranch?: boolean;
  /** Optional trailing actions (checkout, new session…). */
  actions?: ReactNode;
  className?: string;
}

/** D04 `Tuile · Branches` row: icon · name (mono 500 13) / detail (Outfit 12 muted) · badge. */
export function BranchRow({ name, detail, badge, protectedBranch, actions, className }: BranchRowProps) {
  const spec = badge ? BADGE[badge] : null;
  return (
    <div className={cn('flex min-w-0 items-center gap-3 border-b border-border py-2.5 last:border-b-0', className)}>
      <Icon name={protectedBranch ? 'lock' : 'git-branch'} size={16} className="text-muted" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="m-0 truncate font-mono text-app-13 font-medium text-text" title={name}>
          {name}
        </p>
        {detail ? <p className="m-0 truncate font-sans text-app-12 text-muted">{detail}</p> : null}
      </div>
      {spec ? <Badge tone={spec.tone}>{spec.label}</Badge> : null}
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}
