import Link from 'next/link';
import { Icon } from '@/components/icons';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { syncBadge, type SyncBadgeInput } from '../lib/git';
import { LiveTime, type DateInput } from '../status/LiveTime';
import { FavoriteToggle } from './FavoriteToggle';

export interface RecentProjectRowProps {
  name: string;
  branch?: string | null;
  sync: SyncBadgeInput;
  lastActivityAt?: DateInput | null;
  favorite?: boolean;
  onToggleFavorite?: () => void;
  favoritePending?: boolean;
  /** Project detail (`/projets/[id]`): the row is a link. */
  href?: string;
  /** `desktop` = D01 `Projets récents` row (star · name/branch · badge · age) · `phone` = M01 row (chevron). */
  variant?: 'desktop' | 'phone';
  className?: string;
}

/** D01 `Tuile · Projets récents` / M01 `Projets récents` row (short sync labels: `2 en retard`). */
export function RecentProjectRow({
  name,
  branch,
  sync,
  lastActivityAt,
  favorite = false,
  onToggleFavorite,
  favoritePending,
  href,
  variant = 'desktop',
  className,
}: RecentProjectRowProps) {
  const badge = syncBadge(sync, 'short');
  const phone = variant === 'phone';
  const nameClass = cn('truncate font-sans font-semibold text-text', phone ? 'text-app-15' : 'text-app-14');
  return (
    <div
      className={cn(
        'relative flex min-w-0 items-center gap-3 border-b border-border',
        phone ? 'py-3 last:border-b-0' : 'py-2.5',
        href && 'transition-colors duration-(--dur-fast) hover:bg-hover',
        className,
      )}
    >
      {!phone ? <FavoriteToggle favorite={favorite} name={name} onToggle={onToggleFavorite} pending={favoritePending} size={16} /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {href ? (
          <Link href={href} className={cn(nameClass, "after:absolute after:inset-0 after:content-['']")}>
            {name}
          </Link>
        ) : (
          <p className={cn(nameClass, 'm-0')}>{name}</p>
        )}
        {branch ? <span className="truncate font-mono text-app-11 text-muted">{branch}</span> : null}
      </div>
      <Badge tone={badge.tone}>{badge.label}</Badge>
      {phone ? (
        href ? (
          <Icon name="chevron" size={16} className="text-muted" />
        ) : null
      ) : lastActivityAt ? (
        <LiveTime value={lastActivityAt} format="age" className="shrink-0 font-mono text-app-11 text-muted" />
      ) : null}
    </div>
  );
}
