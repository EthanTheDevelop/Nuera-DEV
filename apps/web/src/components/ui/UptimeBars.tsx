import { formatPercent, formatShortDate } from '@nuera/shared/format';
import { cn } from '@/lib/cn';

export interface UptimeDay {
  /** Day (ISO date `2026-10-28` or Date). */
  date: string | Date;
  /** Availability ratio 0–1 for that day; `null` when nothing was measured (no invented value). */
  availability: number | null;
  /** The day had an incident (drawn warn, half height). */
  incident?: boolean;
  /** Optional detail for the tooltip (« redémarrage automatique, 2 min »). */
  note?: string;
}

export interface UptimeBarsProps {
  days: readonly UptimeDay[];
  /** Accessible name (« Disponibilité sur 30 jours »). */
  label: string;
  className?: string;
}

/**
 * D08 `Barres`: one bar per day (30), 28 px area, gap 3, bottom-aligned, radius 2; healthy day = success at
 * 55 %, full height; incident day = warn 100 %, half height. Unmeasured days are a short border-coloured
 * stub. Each bar carries its date and availability (title + screen-reader text).
 */
export function UptimeBars({ days, label, className }: UptimeBarsProps) {
  return (
    <ul aria-label={label} className={cn('m-0 flex h-7 w-full list-none items-end gap-[3px] p-0', className)}>
      {days.map((day) => {
        const date = formatShortDate(day.date);
        const text =
          day.availability === null
            ? `${date} · pas de mesure`
            : `${date} · ${formatPercent(Math.floor(day.availability * 10_000) / 100, 2)}${day.note ? ` · ${day.note}` : ''}`;
        const measured = day.availability !== null;
        return (
          <li
            key={typeof day.date === 'string' ? day.date : day.date.toISOString()}
            title={text}
            className={cn(
              'min-w-0 flex-1 rounded-[2px]',
              !measured && 'h-1 bg-border',
              measured && day.incident && 'h-1/2 bg-warn',
              measured && !day.incident && 'h-full bg-success/55',
            )}
          >
            <span className="sr-only">{text}</span>
          </li>
        );
      })}
    </ul>
  );
}
