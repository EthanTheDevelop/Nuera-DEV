import { LOCALE, TIME_ZONE } from '@nuera/shared/format';

/**
 * UI-only date formats missing from @nuera/shared/format (to be moved there by its owner).
 * Same locale and time zone (fr-FR, Europe/Paris).
 */

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** « Mer. 4 nov. » — phone header date (M01 « Mer. 4 nov. · tout est disponible »). */
export function formatShortDay(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${capitalize(get('weekday'))} ${get('day')} ${get('month')}`.replace(/\s+/g, ' ').trim();
}
