import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';

/** Nuera OS Badge tones reused by Nuera Dev: Accent, Succes, Alerte, Danger, Neutre (never ChatGPT). */
export type BadgeTone = 'accent' | 'success' | 'warn' | 'danger' | 'neutral';

export const badgeToneClasses: Record<BadgeTone, string> = {
  accent: 'bg-accent-pale text-accent',
  success: 'bg-success-pale text-success',
  warn: 'bg-warn-pale text-warn',
  danger: 'bg-danger-pale text-danger',
  neutral: 'bg-surface-raised text-muted',
};

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  tone?: BadgeTone;
  /** Optional 12 px leading icon (not in the Figma set; keep for rare compound labels). */
  icon?: IconName;
  children: ReactNode;
}

/**
 * Pill label (Nuera OS `Badge` 57:124): padding 4 × 8, radius full, Outfit 500 12, ≈ 23 px tall.
 * « Le Badge ChatGPT est propre à ChatGPT ; il n'est jamais utilisé pour Claude » → no chatgpt tone here.
 * `neutral` has no border: on white it reads as plain muted text (as designed).
 */
export function Badge({ tone = 'accent', icon, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex w-fit max-w-full shrink-0 items-center gap-1 rounded-full px-2 py-1 font-sans text-app-12 font-medium whitespace-nowrap',
        badgeToneClasses[tone],
        className,
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} size={12} /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}
