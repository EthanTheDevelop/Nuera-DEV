import type { AutoResumeState, CliStatus, UsageLimit, UsageLimitSource } from '@nuera/shared/runner';

/**
 * Usage limit of the Claude subscription (5-hour window, weekly window): recognised only from what
 * the official CLI exposes — the `StopFailure` hook (`error: rate_limit`), the limit message it
 * prints and writes in its transcript, and the status line (`rate_limits.*.resets_at`, Unix
 * seconds). Nothing here estimates a quota: a reset time the CLI did not give stays null.
 */

/** A limit message of the CLI, as seen in a text (transcript block, Stop message, screen). */
export interface LimitText {
  message: string;
  resetsAt: string | null;
  window: UsageLimit['window'];
}

// « Claude AI usage limit reached|1751504400 », « Claude usage limit reached. Your limit will reset
// at 3pm (Europe/Paris). », « 5-hour limit reached ∙ resets 3pm », « You've hit your session limit ·
// resets 3:45pm », « You've hit your weekly limit · resets Mon 9am ». Warnings such as « You've used
// 85% of your session limit » are NOT a stop.
const LIMIT_LINE =
  /(?:claude(?: ai)? usage limit reached[^\n]*|(?:5-hour|five-hour|session|weekly|opus|usage) limit reached[^\n]*|you(?:'|’)ve hit your (?:session|weekly|usage|opus)? ?limit[^\n]*|you have hit your (?:session|weekly|usage)? ?limit[^\n]*)/i;

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function validZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  try {
    // Throws RangeError for an unknown zone.
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone ? zone : null;
  } catch {
    return null;
  }
}

/** Wall-clock parts of an instant in a time zone. */
function zonedParts(at: number, zone: string): { y: number; m: number; d: number; h: number; mi: number; wd: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    y: Number(get('year')),
    m: Number(get('month')) - 1,
    d: Number(get('day')),
    h: Number(get('hour')) % 24,
    mi: Number(get('minute')),
    wd: WEEKDAYS[get('weekday').slice(0, 3).toLowerCase()] ?? 0,
  };
}

/** UTC instant of a wall-clock time in a time zone (two passes: exact outside DST gaps). */
export function zonedTimeToUtc(y: number, m: number, d: number, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(y, m, d, h, mi);
  let at = guess;
  for (let i = 0; i < 2; i += 1) {
    const p = zonedParts(at, zone);
    const asUtc = Date.UTC(p.y, p.m, p.d, p.h, p.mi);
    at -= asUtc - guess;
  }
  return at;
}

/**
 * Reset time of a limit message: an epoch after « | » (older CLIs), else « resets 3pm », « reset at
 * 3:45 pm », « resets Nov 7, 9am », « resets Mon 9am », in the zone named in parentheses or, when
 * none, the zone of the runner (the CLI prints the time of the machine it runs on). The next
 * occurrence of that time (a time just passed counts as passed). Null when no time is written.
 */
export function parseResetTime(text: string, now: number = Date.now(), defaultZone?: string): string | null {
  const epoch = /\|\s*(\d{10,13})\b/.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const match =
    /resets?\s+(?:at\s+)?(?:(?<wd>mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(?:(?<mon>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(?<h>\d{1,2})(?::(?<mi>\d{2}))?\s*(?<ap>am|pm)?(?:\s*\((?<zone>[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\))?/i.exec(text);
  if (!match?.groups) return null;
  const g = match.groups;
  let h = Number(g.h);
  const mi = g.mi ? Number(g.mi) : 0;
  if (g.ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (g.ap.toLowerCase() === 'pm' ? 12 : 0);
  } else if (!g.mi || h > 23) {
    // « resets 3 » alone is not a time.
    return null;
  }
  if (mi > 59) return null;
  const zone = validZone(g.zone) ?? validZone(defaultZone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = zonedParts(now, zone);
  const slack = 60_000;
  if (g.mon && g.day) {
    const month = MONTHS[g.mon.slice(0, 3).toLowerCase()]!;
    let at = zonedTimeToUtc(today.y, month, Number(g.day), h, mi, zone);
    if (at < now - 24 * 3600_000) at = zonedTimeToUtc(today.y + 1, month, Number(g.day), h, mi, zone);
    return new Date(at).toISOString();
  }
  for (let offset = 0; offset < 8; offset += 1) {
    const day = zonedParts(now + offset * 24 * 3600_000, zone);
    if (g.wd && day.wd !== WEEKDAYS[g.wd.slice(0, 3).toLowerCase()]) continue;
    const at = zonedTimeToUtc(day.y, day.m, day.d, h, mi, zone);
    if (at >= now - slack) return new Date(at).toISOString();
  }
  return null;
}

/** The limit message in a text (first matching line), with its reset time and window. */
export function detectLimitText(text: string | null | undefined, now: number = Date.now(), defaultZone?: string): LimitText | null {
  if (!text) return null;
  // Terminal screens: box drawing and repeated blanks do not matter.
  const flat = text.replace(/[│╭╮╰╯─]/g, ' ').replace(/[ \t]+/g, ' ');
  const match = LIMIT_LINE.exec(flat);
  if (!match) return null;
  const message = match[0].trim().slice(0, 300);
  const lower = message.toLowerCase();
  const window: UsageLimit['window'] = lower.includes('weekly') ? 'seven_day' : /5-hour|five-hour|session/.test(lower) ? 'five_hour' : null;
  return { message, resetsAt: parseResetTime(message, now, defaultZone), window };
}

/**
 * Reset time published by the status line (`rate_limits.*.resets_at`, exact) for the window the
 * message names (both, five-hour first, when it names none), when still ahead. `full`: only a window
 * the CLI reports used up (100 %) — the one that stopped the session.
 */
export function resetFromStatus(cli: CliStatus | null, window: UsageLimit['window'], now: number = Date.now(), options: { full?: boolean } = {}): string | null {
  const limits = cli?.rateLimits;
  if (!limits) return null;
  const windows = window === 'seven_day' ? [limits.sevenDay] : window === 'five_hour' ? [limits.fiveHour] : [limits.fiveHour, limits.sevenDay];
  const ahead = windows.filter((w): w is NonNullable<typeof w> => Boolean(w?.resetsAt && Date.parse(w.resetsAt) > now));
  const full = ahead.find((w) => (w.usedPercentage ?? 0) >= 100);
  const pick = options.full ? full : (full ?? ahead[0]);
  return pick?.resetsAt ? new Date(Date.parse(pick.resetsAt)).toISOString() : null;
}

/**
 * Reset time of a stop: a window the status line reports used up (exact), else the time written in
 * the CLI's notice, else the status line's next reset of that window, else unknown.
 */
export function resolveReset(cli: CliStatus | null, found: Pick<LimitText, 'resetsAt' | 'window'>, now: number = Date.now()): string | null {
  return resetFromStatus(cli, found.window, now, { full: true }) ?? found.resetsAt ?? resetFromStatus(cli, found.window, now);
}

export interface AutoResumePolicy {
  /** Delay after the reset time before typing the instruction (default 2 min). */
  marginMs: number;
  /** Reset time unknown: one try every `retryMs` (default 30 min)… */
  retryMs: number;
  /** …for `retryWindowMs` at most (default 6 h). */
  retryWindowMs: number;
  /** Attempts with a known reset time (a limit still active reschedules from its new reset). */
  maxAttempts: number;
}

export const DEFAULT_AUTO_RESUME_POLICY: AutoResumePolicy = {
  marginMs: 2 * 60_000,
  retryMs: 30 * 60_000,
  retryWindowMs: 6 * 3600_000,
  maxAttempts: 5,
};

/**
 * Schedule of the automatic resumption of a limit. `carried` = attempts already made for the same
 * piece of work (the limit was hit again right after an automatic resumption) and, in retry mode,
 * the end of the 6-hour window that started at the first stop.
 */
export function scheduleAutoResume(input: {
  enabled: boolean;
  resetsAt: string | null;
  detectedAt: string;
  carried: { attempts: number; lastAttemptAt: string | null; giveUpAt: string | null } | null;
  policy: AutoResumePolicy;
  now?: number;
}): AutoResumeState {
  const now = input.now ?? Date.now();
  const attempts = input.carried?.attempts ?? 0;
  const lastAttemptAt = input.carried?.lastAttemptAt ?? null;
  const mode: AutoResumeState['mode'] = input.resetsAt ? 'reset' : 'retry';
  const giveUpAt = mode === 'retry' ? (input.carried?.giveUpAt ?? new Date(Date.parse(input.detectedAt) + input.policy.retryWindowMs).toISOString()) : null;
  const maxAttempts = mode === 'reset' ? input.policy.maxAttempts : Math.max(1, Math.floor(input.policy.retryWindowMs / input.policy.retryMs));
  const base = { enabled: input.enabled, mode, attempts, maxAttempts, lastAttemptAt, giveUpAt };
  if (!input.enabled) return { ...base, nextAttemptAt: null, outcome: 'off' };
  if (attempts >= maxAttempts) return { ...base, nextAttemptAt: null, outcome: 'exhausted' };
  let next: number;
  if (mode === 'reset') {
    next = Math.max(Date.parse(input.resetsAt!) + input.policy.marginMs, now + 1000);
  } else {
    next = now + input.policy.retryMs;
    if (next > Date.parse(giveUpAt!)) return { ...base, nextAttemptAt: null, outcome: 'exhausted' };
  }
  return { ...base, nextAttemptAt: new Date(next).toISOString(), outcome: 'scheduled' };
}

/** What a new stop inherits from the current record (null: a fresh piece of work). */
function carriedFrom(previous: UsageLimit | null): { attempts: number; lastAttemptAt: string | null; giveUpAt: string | null } | null {
  const resume = previous?.autoResume;
  if (!resume) return null;
  // Same stop seen again, or the limit hit again after an automatic resumption: same count.
  if (previous.active || resume.outcome === 'fired') return { attempts: resume.attempts, lastAttemptAt: resume.lastAttemptAt, giveUpAt: resume.giveUpAt };
  return null;
}

/**
 * Usage-limit record after a detection. The same stop reported several times (hook, transcript,
 * screen) keeps its first detection and is completed (a reset time learnt later); a stop after an
 * automatic resumption keeps the attempts already made.
 */
export function buildUsageLimit(input: {
  previous: UsageLimit | null;
  source: UsageLimitSource;
  message: string | null;
  resetsAt: string | null;
  window: UsageLimit['window'];
  autoResumeEnabled: boolean;
  policy: AutoResumePolicy;
  now?: number;
}): UsageLimit {
  const now = input.now ?? Date.now();
  const same = input.previous?.active ? input.previous : null;
  const detectedAt = same?.detectedAt ?? new Date(now).toISOString();
  const resetsAt = input.resetsAt ?? same?.resetsAt ?? null;
  const keep = same?.autoResume && same.resetsAt === resetsAt && same.autoResume.enabled === input.autoResumeEnabled;
  return {
    active: true,
    detectedAt,
    resetsAt,
    source: same?.source ?? input.source,
    window: same?.window ?? input.window,
    message: same?.message ?? input.message,
    autoResume: keep
      ? same.autoResume
      : scheduleAutoResume({ enabled: input.autoResumeEnabled, resetsAt, detectedAt, carried: carriedFrom(input.previous), policy: input.policy, now }),
  };
}
