import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/icons';

const clamp = (n: number) => Math.min(100, Math.max(0, n));

export interface ProgressBarProps {
  /** 0–100. `null` = indeterminate (no width is invented: the bar shows an empty track). */
  value: number | null;
  /** Accessible name (« Clonage de nuera-studio/roux-conseil »). */
  label: string;
  /** Spoken value (default « 64 % »). */
  valueText?: string;
  className?: string;
}

/**
 * A2 `Barre`: height 8, surface-raised track + 1 px border, radius full, accent fill = percent.
 * role="progressbar" with aria-valuenow. Width transitions with --dur-base --ease-steady.
 */
export function ProgressBar({ value, label, valueText, className }: ProgressBarProps) {
  const pct = value === null ? null : clamp(value);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-valuetext={pct === null ? undefined : (valueText ?? `${Math.round(pct)} %`)}
      className={cn('h-2 w-full overflow-hidden rounded-full border border-border bg-surface-raised', className)}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-(--dur-base) ease-steady"
        style={{ width: `${pct ?? 0}%` }}
      />
    </div>
  );
}

export interface StepProgressProps {
  /** Number of segments (M03: 3). */
  total: number;
  /** 1-based current step; segments up to it are accent. */
  current: number;
  label?: string;
  className?: string;
}

/** M03 3-segment progress: px 16, gap 4, each flex-1 × 4 px, radius 2; done/current accent, upcoming border. */
export function StepProgress({ total, current, label = 'Progression', className }: StepProgressProps) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-valuetext={`Étape ${current} sur ${total}`}
      className={cn('flex w-full gap-1', className)}
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-1 flex-1 rounded-[2px] transition-colors duration-(--dur-base) ease-steady',
            i < current ? 'bg-accent' : 'bg-border',
          )}
        />
      ))}
    </div>
  );
}

export interface StepperStep {
  label: string;
}

export interface StepperProps {
  steps: readonly StepperStep[];
  /** 0-based index of the current step; earlier steps are done. */
  current: number;
  className?: string;
}

/**
 * Desktop modal stepper (« Dépôt · Configuration · Clonage »): 24 px circles joined by 40 × 1 connectors.
 * current = accent circle + mono bold number in paper + SemiBold label; upcoming = surface-raised + border,
 * muted number and label; done = success-pale circle with a 14 px check.
 */
export function Stepper({ steps, current, className }: StepperProps) {
  return (
    <ol className={cn('m-0 flex list-none flex-wrap items-center gap-2 p-0', className)}>
      {steps.map((step, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'upcoming';
        return (
          <li key={step.label} className="flex items-center gap-2" aria-current={state === 'current' ? 'step' : undefined}>
            {i > 0 ? <span aria-hidden className="h-px w-10 bg-border" /> : null}
            <span
              aria-hidden
              className={cn(
                'inline-flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-app-12 font-bold',
                state === 'current' && 'bg-accent text-on-accent',
                state === 'upcoming' && 'border border-border bg-surface-raised text-muted',
                state === 'done' && 'bg-success-pale text-success',
              )}
            >
              {state === 'done' ? <Icon name="check" size={14} /> : i + 1}
            </span>
            <span
              className={cn(
                'font-sans text-app-14',
                state === 'current' && 'font-semibold text-text',
                state === 'upcoming' && 'text-muted',
                state === 'done' && 'text-text',
              )}
            >
              <span className="sr-only">{state === 'done' ? 'Terminé : ' : state === 'current' ? 'En cours : ' : 'À venir : '}</span>
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StepListItem {
  key: string;
  label: ReactNode;
  status: StepStatus;
  /** Right meta, JetBrains Mono 11 muted (« 84 Mo · 12 s », « en cours · 31 s », « en attente »). */
  meta?: ReactNode;
}

const stepIcon: Record<StepStatus, { name: IconName; className: string; sr: string }> = {
  done: { name: 'check', className: 'text-success', sr: 'Terminé' },
  running: { name: 'clock', className: 'text-en-cours', sr: 'En cours' },
  pending: { name: 'minus', className: 'text-muted', sr: 'En attente' },
  failed: { name: 'alert', className: 'text-danger', sr: 'Échec' },
  skipped: { name: 'minus', className: 'text-muted', sr: 'Ignoré' },
};

/**
 * A2 sub-steps (`Étapes`, gap 8): icon 16 + label Outfit 14 + meta. done = check success, running = clock
 * en-cours (label Medium), pending = minus muted (label muted). Mirrors `operations.steps` statuses.
 */
export function StepList({ items, className }: { items: readonly StepListItem[]; className?: string }) {
  return (
    <ul className={cn('m-0 flex list-none flex-col gap-2 p-0', className)}>
      {items.map((item) => {
        const icon = stepIcon[item.status];
        return (
          <li key={item.key} className="flex items-center gap-2.5">
            <Icon name={icon.name} size={16} className={icon.className} />
            <span
              className={cn(
                'min-w-0 flex-1 font-sans text-app-14',
                item.status === 'running' ? 'font-medium text-text' : item.status === 'pending' || item.status === 'skipped' ? 'text-muted' : 'text-text',
              )}
            >
              <span className="sr-only">{`${icon.sr} : `}</span>
              {item.label}
            </span>
            {item.meta ? <span className="shrink-0 font-mono text-app-11 text-muted">{item.meta}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
