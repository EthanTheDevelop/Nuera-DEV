/**
 * Presentation of a usage-limit stop (`sessions.usage_limit`, `UsageLimit` of @nuera/shared/runner)
 * in every composite: Workspace banner, header badge, Sessions cards / rows, Accueil.
 *
 * Only what the official CLI gave is shown: the reset time comes from its status line or from its
 * own notice (« 5-hour limit reached ∙ resets 3pm »); an unknown reset stays unknown (« nouvel
 * essai à … » when the automatic resumption tries every 30 min). Nothing here estimates a quota.
 */
import type { UsageLimit } from '@nuera/shared/runner';
import { formatClockDay } from '@nuera/shared/format';

export type { UsageLimit };

type DateInput = Date | string | number;

function validTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** The limit stops the session right now (an automatic resumption already typed is behind us). */
export function isUsageLimited(limit: UsageLimit | null | undefined): limit is UsageLimit {
  return Boolean(limit?.active);
}

/** Next automatic attempt, when one is scheduled (ISO), else null. */
export function scheduledResumeAt(limit: UsageLimit | null | undefined): string | null {
  if (!isUsageLimited(limit)) return null;
  const resume = limit.autoResume;
  if (!resume?.enabled || resume.outcome !== 'scheduled') return null;
  return validTime(resume.nextAttemptAt) === null ? null : resume.nextAttemptAt;
}

/** Reset time given by the CLI (ISO), else null. */
export function limitResetAt(limit: UsageLimit | null | undefined): string | null {
  return limit && validTime(limit.resetsAt) !== null ? limit.resetsAt : null;
}

/**
 * Short label of cards, rows, Accueil and the header badge:
 * « Limite atteinte · reprise à 15 h 02 », « Limite atteinte · nouvel essai à 15 h 30 »,
 * « Limite atteinte · levée à 15 h 00 », « Limite atteinte ». Null when no limit stops the session.
 */
export function usageLimitLabel(limit: UsageLimit | null | undefined, now: DateInput = new Date()): string | null {
  if (!isUsageLimited(limit)) return null;
  const next = scheduledResumeAt(limit);
  if (next) return `Limite atteinte · ${limit.autoResume?.mode === 'retry' ? 'nouvel essai' : 'reprise'} à ${formatClockDay(next, now)}`;
  const reset = limitResetAt(limit);
  if (reset) return `Limite atteinte · levée à ${formatClockDay(reset, now)}`;
  return 'Limite atteinte';
}

/** « tentative 2 sur 5 » (the attempt that will run next), null when nothing is scheduled. */
export function nextAttemptLabel(limit: UsageLimit | null | undefined): string | null {
  if (!scheduledResumeAt(limit)) return null;
  const resume = limit!.autoResume!;
  return `tentative ${Math.min(resume.attempts + 1, resume.maxAttempts)} sur ${resume.maxAttempts}`;
}

/** « dans 1 h 05 », « dans 4 min », « dans 12 s », « imminente » (live countdown of the banner). */
export function countdownLabel(target: string | null | undefined, now: DateInput = new Date()): string | null {
  const at = validTime(target ?? null);
  if (at === null) return null;
  const nowMs = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  const seconds = Math.ceil((at - nowMs) / 1000);
  if (seconds <= 0) return 'imminente';
  if (seconds < 60) return `dans ${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `dans ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `dans ${hours} h ${String(minutes % 60).padStart(2, '0')}`;
}

/** Effective « Reprise automatique » of a session: its own choice, else the space default. */
export function effectiveAutoResume(override: boolean | null | undefined, spaceDefault: boolean): boolean {
  return override ?? spaceDefault;
}

/**
 * Body of the Workspace banner (below its title « Limite d'utilisation atteinte »): the reset the
 * CLI announced and what happens next.
 */
export function usageLimitDetail(limit: UsageLimit, now: DateInput = new Date()): string {
  const reset = limitResetAt(limit);
  const resetText = reset ? `Le CLI annonce la levée de la limite à ${formatClockDay(reset, now)}.` : "Le CLI n'a pas indiqué l'heure de levée de la limite.";
  const resume = limit.autoResume;
  const next = scheduledResumeAt(limit);
  if (next) {
    const when = formatClockDay(next, now);
    return resume?.mode === 'retry'
      ? `${resetText} Nouvel essai automatique à ${when} (${nextAttemptLabel(limit)}).`
      : `${resetText} Reprise automatique à ${when} (${nextAttemptLabel(limit)}).`;
  }
  if (resume?.outcome === 'exhausted') return `${resetText} Reprise automatique abandonnée après ${resume.attempts} tentative${resume.attempts > 1 ? 's' : ''}.`;
  return `${resetText} Reprenez la session quand vous le souhaitez.`;
}
