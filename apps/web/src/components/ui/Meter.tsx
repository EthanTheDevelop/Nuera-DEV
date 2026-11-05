import { cn } from '@/lib/cn';

const clamp = (n: number) => Math.min(100, Math.max(0, n));

export interface MeterProps {
  /** Label (Outfit 13 muted): « Processeur », « Mémoire », « Stockage ». */
  label: string;
  /** Formatted value (JetBrains Mono 500 12): « 23 % », « 5,1 / 16 Go » — format with @nuera/shared/format. */
  valueLabel: string;
  /** Fill ratio 0–100. `null` when the metric is unknown: the track stays empty and nothing is invented. */
  percent: number | null;
  /** `warn` / `danger` fill above thresholds decided by the caller. */
  tone?: 'accent' | 'warn' | 'danger';
  className?: string;
}

const fills = { accent: 'bg-accent', warn: 'bg-warn', danger: 'bg-danger' } as const;

/**
 * D01 `Jauge · Processeur / Mémoire / Stockage` (column gap 6): label row space-between; track 8 px incl.
 * 1 px border, surface-raised, radius full; fill accent, radius 4, inset 1 px. role="meter".
 */
export function Meter({ label, valueLabel, percent, tone = 'accent', className }: MeterProps) {
  const pct = percent === null ? null : clamp(percent);
  return (
    <div className={cn('flex w-full flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-sans text-app-13 text-muted">{label}</span>
        <span className="font-mono text-app-12 font-medium text-text">{valueLabel}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={valueLabel}
        className="h-2 w-full overflow-hidden rounded-full border border-border bg-surface-raised p-px"
      >
        <div
          className={cn('h-full rounded-[4px] transition-[width] duration-(--dur-base) ease-steady', fills[tone])}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
    </div>
  );
}

export interface SlotMeterProps {
  /** Slots in use (active sessions). */
  used: number;
  /** Allowed slots (app_settings.maxConcurrentSessions). */
  total: number;
  /** Accessible label (« 2 sessions actives sur 4 autorisées »). */
  label: string;
  className?: string;
}

/**
 * D06 capacity `Jauge`: one slot per allowed session — track h 10, slots flex-1 with 4 px gaps, radius 5;
 * used = accent, free = surface-raised + 1 px border.
 */
export function SlotMeter({ used, total, label, className }: SlotMeterProps) {
  const slots = Math.max(0, total);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={slots}
      aria-valuenow={Math.min(used, slots)}
      className={cn('flex h-2.5 w-full gap-1', className)}
    >
      {Array.from({ length: slots }, (_, i) => (
        <span
          key={i}
          className={cn('h-full flex-1 rounded-[5px]', i < used ? 'bg-accent' : 'border border-border bg-surface-raised')}
        />
      ))}
    </div>
  );
}
