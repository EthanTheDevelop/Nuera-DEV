import { describe, expect, it } from 'vitest';
import { cn } from './cn';
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

describe('parseThemePreference', () => {
  it('accepts the three preferences and falls back to light', () => {
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('system')).toBe('system');
    expect(parseThemePreference('nope')).toBe('light');
    expect(parseThemePreference(undefined)).toBe('light');
  });
});
