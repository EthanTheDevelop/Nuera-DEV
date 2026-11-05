import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';
import { renderAction, type ActionElementProps } from './action';
import { Spinner } from './Spinner';

export type CompactButtonVariant = 'principal' | 'secondaire' | 'discret';

interface CompactButtonOwnProps {
  /**
   * « Principal = l'action attendue (une seule par carte), Secondaire = alternative, Discret = action
   * mineure (annuler, déplacer). » Default `principal`.
   */
  variant?: CompactButtonVariant;
  /** Leading 16 px icon « qui dit l'action » (check, play, refresh, upload, stop, plus, external…). */
  icon?: IconName;
  /** `md` = 36 px (desktop, 44 px hit area); `lg` = 44 px (phone primary/secondary actions). */
  size?: 'md' | 'lg';
  /** Stretch to the container width, label centred (phone action bars, permission card). */
  block?: boolean;
  /** Spinner in place of the icon; disables the control and sets aria-busy. */
  loading?: boolean;
  className?: string;
  children: ReactNode;
}

export type CompactButtonProps = CompactButtonOwnProps & ActionElementProps;

const variants: Record<CompactButtonVariant, string> = {
  principal: 'bg-accent text-on-accent pl-3 pr-3.5 hover:bg-accent-hover active:bg-accent-pressed',
  secondaire:
    'bg-paper text-ink border border-border-on-light pl-3 pr-3.5 hover:bg-paper-hover active:bg-paper-pressed',
  discret: 'bg-transparent text-accent px-0 hover:text-accent-hover hover:underline underline-offset-4',
};

/**
 * Nuera OS « Bouton compact » (168:6952): 36 px, Outfit 500 14, 16 px icon, radius 12, gap 6,
 * padding 12/14 (Discret has none). Zone cliquable 44 px en code. Disabled = 40 % opacity (W7).
 */
export function CompactButton({
  variant = 'principal',
  icon,
  size = 'md',
  block,
  loading = false,
  className,
  children,
  ...props
}: CompactButtonProps) {
  const classes = cn(
    'nu-hit inline-flex shrink-0 items-center gap-1.5 rounded-md font-sans text-app-14 font-medium whitespace-nowrap select-none',
    'transition-colors duration-(--dur-fast) ease-out',
    'disabled:cursor-not-allowed disabled:not-aria-busy:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40',
    'aria-busy:cursor-progress',
    size === 'md' ? 'h-9' : 'h-11',
    block ? 'w-full justify-center' : 'w-fit',
    variants[variant],
    className,
  );
  const leading = loading ? <Spinner size={16} /> : icon ? <Icon name={icon} size={16} /> : null;
  return renderAction({
    props,
    className: classes,
    busy: loading,
    children: (
      <>
        {leading}
        <span className="min-w-0 truncate">{children}</span>
      </>
    ),
  });
}
