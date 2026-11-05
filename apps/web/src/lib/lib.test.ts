import { describe, expect, it } from 'vitest';
import { cn } from './cn';
import { formatShortDay } from './format';
import { parseThemePreference } from './theme';

describe('cn', () => {
  it('keeps an app font size next to a text colour', () => {
    expect(cn('text-app-14 text-muted')).toBe('text-app-14 text-muted');
  });
  it('resolves conflicting sizes and colours, last wins', () => {
    expect(cn('text-app-14', 'text-app-13')).toBe('text-app-13');
    expect(cn('text-muted', 'text-accent')).toBe('text-accent');
    expect(cn('shadow-soft', 'shadow-float')).toBe('shadow-float');
  });
});

describe('formatShortDay', () => {
  it('prints the phone header date « Mer. 4 nov. »', () => {
    expect(formatShortDay(new Date('2026-11-04T10:00:00+01:00'))).toBe('Mer. 4 nov.');
  });
  it('uses the Paris day near midnight', () => {
    expect(formatShortDay('2026-11-04T23:30:00Z')).toBe('Jeu. 5 nov.');
  });
});

describe('parseThemePreference', () => {
  it('accepts the three preferences and falls back to light', () => {
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('system')).toBe('system');
    expect(parseThemePreference('nope')).toBe('light');
    expect(parseThemePreference(undefined)).toBe('light');
  });
});
