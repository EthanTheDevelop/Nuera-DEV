/**
 * French formatting helpers matching the copy used in the Figma mockups.
 * Locale fr-FR, time zone Europe/Paris. Pure functions (usable on server and client).
 *
 * Examples (Figma): « il y a 4 min », « il y a 2 h », « hier », « lun. », « 28 oct. »,
 * « Mercredi 4 novembre 2026 », « 12 min », « 1 h 05 », « 5,1 / 16 Go », « 23 % », « a3f9c12 ».
 */

export const LOCALE = 'fr-FR';
export const TIME_ZONE = 'Europe/Paris';

type DateInput = Date | string | number;

const toDate = (value: DateInput): Date => (value instanceof Date ? value : new Date(value));

const dayFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** yyyy-mm-dd key of a date in Europe/Paris. */
export function parisDayKey(value: DateInput): string {
  const parts = dayFormatter.formatToParts(toDate(value));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function dayDiff(a: Date, b: Date): number {
  const ka = Date.parse(`${parisDayKey(a)}T00:00:00Z`);
  const kb = Date.parse(`${parisDayKey(b)}T00:00:00Z`);
  return Math.round((kb - ka) / 86_400_000);
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** « 10:42 » */
export function formatTime(value: DateInput): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' }).format(
    toDate(value),
  );
}

/** « 28 oct. » (adds the year when different from the reference year: « 28 oct. 2025 »). */
export function formatShortDate(value: DateInput, now: DateInput = new Date()): string {
  const d = toDate(value);
  const sameYear =
    new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, year: 'numeric' }).format(d) ===
    new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, year: 'numeric' }).format(toDate(now));
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIME_ZONE,
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(d);
}

/** « Mercredi 4 novembre 2026 » */
export function formatLongDate(value: DateInput): string {
  return capitalize(
    new Intl.DateTimeFormat(LOCALE, {
      timeZone: TIME_ZONE,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(toDate(value)),
  );
}

/** « Mer. 4 nov. » — phone header date (M01 « Mer. 4 nov. · tout est disponible »). */
export function formatShortDay(value: DateInput): string {
  const parts = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(
    toDate(value),
  );
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${capitalize(get('weekday'))} ${get('day')} ${get('month')}`.replace(/\s+/g, ' ').trim();
}

/** « lun. 2 nov. 21:05 » — used in history tables. */
export function formatDateTimeShort(value: DateInput, now: DateInput = new Date()): string {
  const d = toDate(value);
  const diff = dayDiff(d, toDate(now));
  if (diff === 0) return `aujourd'hui ${formatTime(d)}`;
  if (diff === 1) return `hier ${formatTime(d)}`;
  if (diff > 1 && diff < 7) {
    const wd = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, weekday: 'short' }).format(d);
    return `${wd} ${formatShortDate(d, now)} ${formatTime(d)}`;
  }
  return `${formatShortDate(d, now)} ${formatTime(d)}`;
}

/**
 * Relative time as written in the mockups:
 * « maintenant », « il y a 4 min », « il y a 2 h », « hier », « lun. » (this week), « 28 oct. ».
 */
export function formatRelative(value: DateInput, now: DateInput = new Date()): string {
  const d = toDate(value);
  const n = toDate(now);
  const seconds = Math.round((n.getTime() - d.getTime()) / 1000);
  if (seconds < 45) return 'maintenant';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  const days = dayDiff(d, n);
  if (days === 0) return `il y a ${hours} h`;
  if (days === 1) return 'hier';
  if (days > 1 && days < 7) {
    return new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, weekday: 'short' }).format(d);
  }
  return formatShortDate(d, n);
}

/** Compact age for meta columns: « 3 min », « 2 h », « hier », « lun. », « 28 oct. ». */
export function formatAge(value: DateInput, now: DateInput = new Date()): string {
  const rel = formatRelative(value, now);
  return rel.startsWith('il y a ') ? rel.slice('il y a '.length) : rel;
}

/** Duration from milliseconds: « 45 s », « 12 min », « 1 h 05 », « 2 h 40 ». */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h} h ${String(m).padStart(2, '0')}`;
}

const numberFormats = new Map<number, Intl.NumberFormat>();
function numberFormat(fractionDigits: number): Intl.NumberFormat {
  const digits = Math.min(Math.max(Math.trunc(fractionDigits), 0), 3);
  let format = numberFormats.get(digits);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
    numberFormats.set(digits, format);
  }
  return format;
}

/** Plain French number with regular spaces (Figma uses regular spaces, not U+202F). */
export function formatNumber(value: number, fractionDigits = 0): string {
  return numberFormat(fractionDigits).format(value).replace(/[  ]/g, ' ');
}

/** « 23 % », « 99,95 % » (`fractionDigits` = at most that many decimals, 0–3). */
export function formatPercent(value: number, fractionDigits = 0): string {
  return `${formatNumber(value, fractionDigits)} %`;
}

const GB = 1024 ** 3;

/** Bytes → « 5,1 Go », « 512 Mo », « 2,4 Go ». */
export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${formatNumber(bytes / GB, bytes >= 100 * GB ? 0 : 1)} Go`;
  if (bytes >= 1024 ** 2) return `${formatNumber(bytes / 1024 ** 2)} Mo`;
  if (bytes >= 1024) return `${formatNumber(bytes / 1024)} Ko`;
  return `${bytes} o`;
}

/** Used / total in gigabytes: « 5,1 / 16 Go ». */
export function formatUsage(usedBytes: number, totalBytes: number): string {
  const used = usedBytes / GB;
  const total = totalBytes / GB;
  return `${formatNumber(used, used >= 100 ? 0 : 1)} / ${formatNumber(total, total >= 100 ? 0 : total % 1 === 0 ? 0 : 1)} Go`;
}

/** « a3f9c12 » */
export function shortSha(sha: string | null | undefined): string {
  return (sha ?? '').slice(0, 7);
}

/** « 0 fichier », « 1 fichier », « 4 fichiers » (French: 0 and 1 take the singular). */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatNumber(count)} ${Math.abs(count) >= 2 ? pluralForm : singular}`;
}

/**
 * Initials for avatars. Two words → first letters (« Ethan Ngo » → « EN »).
 * One word → first letter + first consonant after it (« Nezar » → « NZ », as in Figma).
 */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
  const word = parts[0] ?? '';
  if (word.length <= 2) return word.toUpperCase();
  const rest = word.slice(1);
  const consonant = /[b-df-hj-np-tv-z]/i.exec(rest)?.[0] ?? rest[0] ?? '';
  return `${word[0]}${consonant}`.toUpperCase();
}
