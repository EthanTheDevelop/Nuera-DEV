import Link from 'next/link';
import { Pastille } from '@/components/ui';
import { cn } from '@/lib/cn';

export interface NewSessionCardProps {
  /** Opens the new-session flow (choose project and branch). */
  href?: string;
  onClick?: () => void;
  /** Capacity reached, runner unavailable…: the tile is disabled and says why. */
  disabledReason?: string | null;
  title?: string;
  description?: string;
  className?: string;
}

const DEFAULT_DESCRIPTION =
  'Choisir un projet et une branche. Un worktree dédié est créé, la session tourne même navigateur fermé.';

/** D06 `Nouvelle session` add tile (215:1941): dashed, centred plus pastille and explanation. */
export function NewSessionCard({
  href,
  onClick,
  disabledReason,
  title = 'Démarrer une session',
  description = DEFAULT_DESCRIPTION,
  className,
}: NewSessionCardProps) {
  const disabled = Boolean(disabledReason) || (!href && !onClick);
  const classes = cn(
    'flex min-h-[203px] w-full min-w-0 flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed border-border p-5 text-center',
    disabled ? 'cursor-not-allowed' : 'transition-colors duration-(--dur-fast) hover:bg-hover',
    className,
  );
  const content = (
    <>
      <Pastille icon="plus" size={40} shape="circle" className={cn(disabled && 'opacity-40')} />
      <span className={cn('font-sans text-app-15 font-semibold text-accent', disabled && 'opacity-40')}>{title}</span>
      <span className="max-w-[360px] font-sans text-app-13 leading-[18px] text-muted">
        {disabledReason ?? description}
      </span>
    </>
  );
  if (disabled) {
    return (
      <div aria-disabled className={classes} role="group" aria-label={title}>
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
