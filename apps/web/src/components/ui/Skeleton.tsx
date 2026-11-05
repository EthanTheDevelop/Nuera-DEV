import type { CSSProperties } from 'react';
import { cn } from '@/lib/cn';

/**
 * T1 « Silhouettes à la place des lignes tant que la liste arrive ; le bandeau dit ce qui se synchronise.
 * En mouvement réduit, pas de miroitement : les silhouettes restent fixes. »
 * Bars use the border colour at 70 % (text) / 50 % (pills), radius 4 / 11. The shimmer is optional and
 * disabled under prefers-reduced-motion (components.css).
 */
export interface SkeletonProps {
  /** Width in px or any CSS length. */
  width?: number | string;
  /** Height in px (default 12, the first text bar of T1). */
  height?: number;
  shape?: 'bar' | 'circle' | 'pill';
  shimmer?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ width = '100%', height = 12, shape = 'bar', shimmer = true, className, style }: SkeletonProps) {
  return (
    <span
      aria-hidden
      className={cn(
        'block shrink-0',
        shimmer && 'nu-skeleton',
        shape === 'circle' && 'rounded-full bg-border',
        shape === 'bar' && 'rounded-[4px] bg-border/70',
        shape === 'pill' && 'rounded-[11px] bg-border/50',
        className,
      )}
      style={{ width, height, ...style }}
    />
  );
}

export interface SkeletonRowProps {
  /** Widths of the two text bars (T1 rows: 160/220, 146/200, 132/180, 118/160). */
  widths?: readonly [number, number];
  /** Show the leading 18 px circle (icon/avatar placeholder). */
  leading?: boolean;
  /** Show the trailing 80 × 22 badge placeholder. */
  trailing?: boolean;
  shimmer?: boolean;
  className?: string;
}

/** `Ligne fantôme`: padding 16 × 0, gap 16, 1 px border bottom (none on the last row). */
export function SkeletonRow({ widths = [160, 220], leading = true, trailing = true, shimmer, className }: SkeletonRowProps) {
  return (
    <div className={cn('flex items-center gap-4 border-b border-border py-4 last:border-b-0', className)}>
      {leading ? <Skeleton shape="circle" width={18} height={18} shimmer={shimmer} /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton width={widths[0]} height={12} shimmer={shimmer} className="max-w-full" />
        <Skeleton width={widths[1]} height={10} shimmer={shimmer} className="max-w-full" />
      </div>
      {trailing ? <Skeleton shape="pill" width={80} height={22} shimmer={shimmer} /> : null}
    </div>
  );
}

const T1_WIDTHS: readonly (readonly [number, number])[] = [
  [160, 220],
  [146, 200],
  [132, 180],
  [118, 160],
];

export interface SkeletonListProps {
  rows?: number;
  /** Screen-reader text (default « Chargement… »). */
  label?: string;
  /** Wrap in the T1 table card (bg, radius 28, padding 8 × 20, Shadow/Soft). */
  card?: boolean;
  shimmer?: boolean;
  className?: string;
}

/** `Tableau en chargement` (T1): 4 decreasing ghost rows; announces « Chargement… » once. */
export function SkeletonList({ rows = 4, label = 'Chargement…', card = true, shimmer, className }: SkeletonListProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn(card && 'rounded-xl bg-bg px-5 py-2 shadow-soft', 'flex flex-col', className)}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} widths={T1_WIDTHS[i % T1_WIDTHS.length]} shimmer={shimmer} />
      ))}
    </div>
  );
}
