import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';

export type PastilleTone = 'accent' | 'success' | 'warn' | 'danger';
export type PastilleSize = 28 | 32 | 40 | 48 | 56;

const tones: Record<PastilleTone, string> = {
  accent: 'bg-accent-pale text-accent',
  success: 'bg-success-pale text-success',
  warn: 'bg-warn-pale text-warn',
  danger: 'bg-danger-pale text-danger',
};

const boxes: Record<PastilleSize, { box: string; icon: number; square: string }> = {
  28: { box: 'size-7', icon: 16, square: 'rounded-sm' },
  32: { box: 'size-8', icon: 18, square: 'rounded-md' },
  40: { box: 'size-10', icon: 20, square: 'rounded-md' },
  48: { box: 'size-12', icon: 24, square: 'rounded-md' },
  56: { box: 'size-14', icon: 26, square: 'rounded-md' },
};

export interface PastilleProps {
  icon: IconName;
  /** 28 = tile header (radius 8, icon 16) · 40 = T8 dialog head · 48 = T5/T6 · 56 = T2 empty state (circle). */
  size?: PastilleSize;
  tone?: PastilleTone;
  shape?: 'square' | 'circle';
  className?: string;
}

/** Icon pill (« Pastille »): tinted square or circle with the matching strong-colour icon. Decorative. */
export function Pastille({ icon, size = 28, tone = 'accent', shape = 'square', className }: PastilleProps) {
  const spec = boxes[size];
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        spec.box,
        shape === 'circle' ? 'rounded-full' : spec.square,
        tones[tone],
        className,
      )}
    >
      <Icon name={icon} size={spec.icon} />
    </span>
  );
}
