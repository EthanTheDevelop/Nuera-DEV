import { cn } from '@/lib/cn';

export type LogoTone = 'auto' | 'papier' | 'encre';

export interface DevBadgeProps {
  /**
   * `papier` = on dark backgrounds (accent-on-dark pill, near-black text) · `encre` = on light backgrounds
   * (accent pill, paper text) · `auto` (default) follows the scope: accent + on-accent roles give encre on
   * light and papier inside a `data-tone="dark"` section.
   */
  tone?: LogoTone;
  /** Base font size in px; every measure is in em so the pill scales as one piece (cover = 16.8). */
  size?: number;
  className?: string;
}

const tones: Record<LogoTone, string> = {
  auto: 'bg-accent text-on-accent',
  papier: 'bg-accent-on-dark text-near-black',
  encre: 'bg-accent-on-light text-paper',
};

/**
 * The `DEV` pill (« même construction que la pastille OS de Nuera OS »): JetBrains Mono 700 12,
 * tracking 0.08em, padding 2 × 4, radius 8 → ≈ 32 × 20 px at 12 px.
 */
export function DevBadge({ tone = 'auto', size = 12, className }: DevBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-[0.6667em] px-[0.3333em] py-[0.1667em] font-mono leading-normal font-bold tracking-label select-none',
        tones[tone],
        className,
      )}
      style={{ fontSize: size }}
    >
      DEV
    </span>
  );
}
