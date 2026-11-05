import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SectionLabelProps {
  children: ReactNode;
  /**
   * `label` (default) = Nuera Dev mono overline: JetBrains Mono 11, 0.08em, uppercase, muted
   * (« EN COURS · 2 », « SESSIONS ACTIVES · 2 », table headers) ·
   * `eyebrow` = DS Mono/Eyebrow: 12 px, 0.2em, accent (« 01 · Couleurs »).
   */
  variant?: 'label' | 'eyebrow';
  /** Colour override (`warn` for « À VALIDER TECHNIQUEMENT », `accent`…). */
  tone?: 'muted' | 'accent' | 'warn' | 'text';
  /** Right-aligned element on the same row (« Tout voir » link, 44 px icon button). */
  action?: ReactNode;
  as?: 'p' | 'h2' | 'h3' | 'span' | 'div';
  id?: string;
  className?: string;
}

const tones = { muted: 'text-muted', accent: 'text-accent', warn: 'text-warn', text: 'text-text' } as const;

/** Mono caps eyebrow / overline. Store copy as written in Figma; uppercase is applied by CSS too. */
export function SectionLabel({ children, variant = 'label', tone, action, as: Tag = 'p', id, className }: SectionLabelProps) {
  const label = (
    <Tag
      id={id}
      className={cn(
        'm-0 font-mono uppercase',
        variant === 'label' ? 'text-app-11 tracking-label' : 'text-xs leading-subtitle tracking-eyebrow',
        tones[tone ?? (variant === 'label' ? 'muted' : 'accent')],
        !action && className,
      )}
    >
      {children}
    </Tag>
  );
  if (!action) return label;
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      {label}
      {action}
    </div>
  );
}
