import type { UsageLimit } from '@nuera/shared/runner';
import { describe, expect, it } from 'vitest';
import { countdownLabel, effectiveAutoResume, nextAttemptLabel, scheduledResumeAt, usageLimitDetail, usageLimitLabel } from './usage-limit';

// 2026-11-06 14:40 in Paris.
const NOW = '2026-11-06T13:40:00Z';

const limit = (over: Partial<UsageLimit> = {}, resume: Partial<NonNullable<UsageLimit['autoResume']>> | null = {}): UsageLimit => ({
  active: true,
  detectedAt: NOW,
  resetsAt: '2026-11-06T14:00:00.000Z',
  source: 'hook',
  window: 'five_hour',
  message: '5-hour limit reached ∙ resets 3pm',
  autoResume:
    resume === null
      ? null
      : {
          enabled: true,
          nextAttemptAt: '2026-11-06T14:02:00.000Z',
          mode: 'reset',
          attempts: 0,
          maxAttempts: 5,
          lastAttemptAt: null,
          giveUpAt: null,
          outcome: 'scheduled',
          ...resume,
        },
  ...over,
});

describe('usage limit labels', () => {
  it('names the scheduled resumption, else the reset the CLI gave, never an invented time', () => {
    expect(usageLimitLabel(limit(), NOW)).toBe('Limite atteinte · reprise à 15 h 02');
    expect(usageLimitLabel(limit({}, { enabled: false, outcome: 'off', nextAttemptAt: null }), NOW)).toBe('Limite atteinte · levée à 15 h 00');
    expect(usageLimitLabel(limit({ resetsAt: null }, null), NOW)).toBe('Limite atteinte');
    expect(usageLimitLabel(limit({ resetsAt: null }, { mode: 'retry', nextAttemptAt: '2026-11-06T14:10:00.000Z', maxAttempts: 12 }), NOW)).toBe(
      'Limite atteinte · nouvel essai à 15 h 10',
    );
    expect(usageLimitLabel(limit({ resetsAt: '2026-11-07T08:00:00.000Z' }, { outcome: 'off', nextAttemptAt: null }), NOW)).toBe('Limite atteinte · levée à demain 9 h 00');
    // Typed already (active false), or no limit: nothing to show.
    expect(usageLimitLabel(limit({ active: false }), NOW)).toBeNull();
    expect(usageLimitLabel(null, NOW)).toBeNull();
    // A malformed date never breaks the rendering.
    expect(usageLimitLabel(limit({ resetsAt: 'pas une date' }, { nextAttemptAt: 'jamais' }), NOW)).toBe('Limite atteinte');
  });

  it('counts the attempts and the time left', () => {
    expect(nextAttemptLabel(limit({}, { attempts: 1 }))).toBe('tentative 2 sur 5');
    expect(nextAttemptLabel(limit({}, { outcome: 'exhausted', nextAttemptAt: null }))).toBeNull();
    expect(scheduledResumeAt(limit({}, { enabled: false }))).toBeNull();
    expect(countdownLabel('2026-11-06T14:02:00.000Z', NOW)).toBe('dans 22 min');
    expect(countdownLabel('2026-11-06T13:40:12.000Z', NOW)).toBe('dans 12 s');
    expect(countdownLabel('2026-11-06T15:45:00.000Z', NOW)).toBe('dans 2 h 05');
    expect(countdownLabel('2026-11-06T13:39:00.000Z', NOW)).toBe('imminente');
    expect(countdownLabel(null, NOW)).toBeNull();
  });

  it('writes the banner and the effective choice', () => {
    expect(usageLimitDetail(limit(), NOW)).toBe('Le CLI annonce la levée de la limite à 15 h 00. Reprise automatique à 15 h 02 (tentative 1 sur 5).');
    expect(usageLimitDetail(limit({ resetsAt: null }, { outcome: 'exhausted', nextAttemptAt: null, attempts: 12 }), NOW)).toBe(
      "Le CLI n'a pas indiqué l'heure de levée de la limite. Reprise automatique abandonnée après 12 tentatives.",
    );
    expect(usageLimitDetail(limit({}, null), NOW)).toBe('Le CLI annonce la levée de la limite à 15 h 00. Reprenez la session quand vous le souhaitez.');
    expect(effectiveAutoResume(null, true)).toBe(true);
    expect(effectiveAutoResume(false, true)).toBe(false);
    expect(effectiveAutoResume(undefined, false)).toBe(false);
  });
});
