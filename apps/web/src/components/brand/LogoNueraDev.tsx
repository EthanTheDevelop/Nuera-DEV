import { cn } from '@/lib/cn';
import { DevBadge, type LogoTone } from './DevBadge';
import { Wordmark } from './Wordmark';

export interface LogoNueraDevProps {
  /**
   * `papier` (201:41, dark backgrounds: white wordmark) · `encre` (201:80, light backgrounds: ink wordmark) ·
   * `auto` (default): wordmark = current text colour, pill from the accent roles — right in both scopes.
   */
  tone?: LogoTone;
  /** Lock-up scale as the base font size in px: 12 → 176 × 27.6 (sidebar), 16.8 → cover (× 1.4). */
  size?: number;
  className?: string;
}

const wordmarkTone: Record<LogoTone, string> = {
  auto: 'text-text',
  papier: 'text-paper',
  encre: 'text-ink',
};

/**
 * « Logo de Nuera Dev : le logo Nuera, suivi de la pastille DEV (même construction que la pastille OS de
 * Nuera OS). » Wordmark 136 × 27.61 + gap 8 + DEV pill, all expressed in em of `size`.
 */
export function LogoNueraDev({ tone = 'auto', size = 12, className }: LogoNueraDevProps) {
  return (
    <span
      role="img"
      aria-label="Nuera Dev"
      className={cn('inline-flex shrink-0 items-center gap-[0.6667em]', wordmarkTone[tone], className)}
      style={{ fontSize: size }}
    >
      <Wordmark height="2.3009em" title={null} />
      <DevBadge tone={tone} size={size} />
    </span>
  );
}
