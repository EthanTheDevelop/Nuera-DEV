import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';
import { renderAction, type ActionElementProps } from './action';
import { Spinner } from './Spinner';

export type IconButtonVariant = 'ghost' | 'outline' | 'accent' | 'tinted';

interface IconButtonOwnProps {
  icon: IconName;
  /** Accessible name (required: the label is never shown, « à porter en aria-label »). */
  label: string;
  /**
   * `ghost` = transparent (phone headers, row menus, modal close) · `outline` = bg + 1 px border
   * (D01/M01 bell) · `accent` = filled accent (M02/M06 « + ») · `tinted` = accent-pale + accent icon.
   */
  variant?: IconButtonVariant;
  /** `sm` = 36 px visual with a 44 px hit area (desktop); `md` = 44 × 44 (phone). Default `md`. */
  size?: 'sm' | 'md';
  /** Icon size override (defaults: 18 for sm, 20 for md). */
  iconSize?: number;
  /** Counter bubble (« 2 ») drawn on the top-left of the icon, as on `Bouton · Changer de session`. */
  badge?: number | string;
  /** Accessible text for the badge (e.g. « 2 sessions sur ce projet »), appended to the label. */
  badgeLabel?: string;
  loading?: boolean;
  /** Icon colour class, e.g. `text-muted` for row menus, `text-accent` for the panel toggle. */
  iconClassName?: string;
  className?: string;
}

export type IconButtonProps = IconButtonOwnProps & ActionElementProps;

const variants: Record<IconButtonVariant, string> = {
  ghost: 'bg-transparent text-text hover:bg-hover active:bg-pressed',
  outline: 'bg-bg text-text border border-border hover:bg-hover active:bg-pressed',
  accent: 'bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-pressed',
  tinted: 'bg-accent-pale text-accent hover:bg-hover active:bg-pressed',
};

/** Square icon-only control with a guaranteed 44 px touch target. */
export function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'md',
  iconSize,
  badge,
  badgeLabel,
  loading = false,
  iconClassName,
  className,
  ...props
}: IconButtonProps) {
  const classes = cn(
    'nu-hit relative inline-flex shrink-0 items-center justify-center rounded-md select-none',
    'transition-colors duration-(--dur-fast) ease-out',
    'disabled:cursor-not-allowed disabled:not-aria-busy:opacity-40 aria-disabled:opacity-40',
    size === 'sm' ? 'size-9' : 'size-11',
    variants[variant],
    className,
  );
  const glyph = iconSize ?? (size === 'sm' ? 18 : 20);
  const name = badge !== undefined && badgeLabel ? `${label} · ${badgeLabel}` : label;
  return renderAction({
    props,
    className: classes,
    busy: loading,
    extra: { 'aria-label': name },
    children: (
      <>
        {loading ? <Spinner size={glyph} /> : <Icon name={icon} size={glyph} className={iconClassName} />}
        {badge !== undefined ? (
          <span
            aria-hidden
            className="absolute top-1.5 left-[26px] rounded-full bg-accent px-[5px] py-px font-sans text-app-10 font-semibold text-on-accent"
          >
            {badge}
          </span>
        ) : null}
      </>
    ),
  });
}
