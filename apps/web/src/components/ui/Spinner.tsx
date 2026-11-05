import { cn } from '@/lib/cn';
import { ICON_STROKE_PX } from '@/components/icons';

export interface SpinnerProps {
  /** Rendered size in px (default 16, the icon size of buttons). */
  size?: number;
  /**
   * Accessible label (e.g. « Chargement… »). Omit it when the spinner sits inside a control that
   * already exposes `aria-busy` — it is then decorative.
   */
  label?: string;
  className?: string;
}

/**
 * Activity indicator drawn like the icon set (1.8 px round stroke, currentColor).
 * Not designed in Figma; used inside loading buttons and for in-flight retries (T5 « Réessayer maintenant »).
 */
export function Spinner({ size = 16, label, className }: SpinnerProps) {
  const sw = (ICON_STROKE_PX * 24) / size;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      className={cn('nu-spin inline-block shrink-0', className)}
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}
