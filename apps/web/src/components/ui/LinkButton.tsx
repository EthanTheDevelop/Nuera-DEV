import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';
import { renderAction, type ActionElementProps } from './action';

interface LinkButtonOwnProps {
  /** Text size: 13 = tile/section links (« Toutes les sessions », « Gérer », « Tout voir »), 14/15 elsewhere. */
  size?: 13 | 14 | 15;
  /** `accent` (default) · `muted` · `text`. */
  tone?: 'accent' | 'muted' | 'text';
  /** Leading icon (back arrow of the phone top bar…). */
  icon?: IconName;
  /** Trailing icon (`external` for GitHub links, `chevron`). */
  trailingIcon?: IconName;
  className?: string;
  children: ReactNode;
}

export type LinkButtonProps = LinkButtonOwnProps & ActionElementProps;

const tones = {
  accent: 'text-accent hover:text-accent-hover',
  muted: 'text-muted hover:text-text',
  text: 'text-text hover:text-accent',
} as const;

const sizes = { 13: 'text-app-13', 14: 'text-app-14', 15: 'text-app-15' } as const;

/** Text-only action (Outfit 500 13 accent in tiles), underlined on hover, 44 px hit area. */
export function LinkButton({
  size = 13,
  tone = 'accent',
  icon,
  trailingIcon,
  className,
  children,
  ...props
}: LinkButtonProps) {
  const classes = cn(
    'nu-hit inline-flex w-fit shrink-0 items-center gap-1 font-sans font-medium whitespace-nowrap',
    'underline-offset-4 hover:underline transition-colors duration-(--dur-fast) ease-out',
    'disabled:cursor-not-allowed disabled:opacity-40',
    sizes[size],
    tones[tone],
    className,
  );
  return renderAction({
    props,
    className: classes,
    children: (
      <>
        {icon ? <Icon name={icon} size={size >= 15 ? 20 : 16} /> : null}
        <span>{children}</span>
        {trailingIcon ? <Icon name={trailingIcon} size={14} /> : null}
      </>
    ),
  });
}
