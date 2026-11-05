'use client';

import {
  formatAge,
  formatDateTimeShort,
  formatDuration,
  formatRelative,
  formatShortDate,
  formatTime,
  parisDayKey,
} from '@nuera/shared/format';
import { useNow } from '../hooks/use-now';

export type DateInput = Date | string | number;

/**
 * - `relative` « il y a 3 min », « hier », « lun. », « 28 oct. »
 * - `activity` like `relative`, the weekday with its date (D02 « lun. 2 nov. »)
 * - `age` « 3 min », « hier », « lun. » (meta columns, card corners)
 * - `elapsed` « 38 s », « 12 min », « 1 h 05 » since `value` (live sessions, running tools)
 * - `time` « 10:42 » · `datetime` « hier 16:20 »
 * - `day` « 16:20 » today, then « hier », « lun. », « 28 oct. » (phone history)
 */
export type LiveTimeFormat = 'relative' | 'activity' | 'age' | 'elapsed' | 'time' | 'datetime' | 'day';

/** Short weekday as written by `formatRelative` within the week (« lun. »). */
const WEEKDAY_RE = /^\p{Ll}{3}\.$/u;

export interface LiveTimeProps {
  value: DateInput;
  format: LiveTimeFormat;
  /** Text before / after the formatted value (« en cours · », « depuis »). */
  prefix?: string;
  suffix?: string;
  /** Freeze the value (galleries, tests). */
  now?: DateInput;
  className?: string;
}

export function formatLiveTime(value: DateInput, format: LiveTimeFormat, now: DateInput): string {
  // A malformed date never breaks the page (Intl throws on Invalid Date): nothing is printed.
  if (Number.isNaN(new Date(value).getTime()) || Number.isNaN(new Date(now).getTime())) return '';
  switch (format) {
    case 'relative':
      return formatRelative(value, now);
    case 'activity': {
      const relative = formatRelative(value, now);
      return WEEKDAY_RE.test(relative) ? `${relative} ${formatShortDate(value, now)}` : relative;
    }
    case 'age':
      return formatAge(value, now);
    case 'elapsed':
      return formatDuration(new Date(now).getTime() - new Date(value).getTime());
    case 'time':
      return formatTime(value);
    case 'datetime':
      return formatDateTimeShort(value, now);
    case 'day':
      return parisDayKey(value) === parisDayKey(now) ? formatTime(value) : formatAge(value, now);
  }
}

/**
 * A `<time>` that keeps itself up to date (every second for `elapsed`, which shows seconds under a
 * minute; every 15 s otherwise). All formatting comes from `@nuera/shared/format` (fr-FR, Europe/Paris).
 */
export function LiveTime({ value, format, prefix, suffix, now: frozen, className }: LiveTimeProps) {
  const start = new Date(value).getTime();
  const ticking = frozen === undefined && format !== 'time';
  const live = useNow(format === 'elapsed' ? 1000 : 15_000, ticking);
  const now = frozen ?? live;
  const iso = Number.isNaN(start) ? undefined : new Date(start).toISOString();
  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {prefix}
      {formatLiveTime(value, format, now)}
      {suffix}
    </time>
  );
}
