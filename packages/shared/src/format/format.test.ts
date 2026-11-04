import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatBytes,
  formatDuration,
  formatLongDate,
  formatPercent,
  formatRelative,
  formatUsage,
  initials,
  shortSha,
} from './index';

const now = new Date('2026-11-04T10:00:00+01:00'); // mercredi

describe('format (fr-FR, Europe/Paris)', () => {
  it('formats relative times like the mockups', () => {
    expect(formatRelative(new Date(now.getTime() - 20_000), now)).toBe('maintenant');
    expect(formatRelative(new Date(now.getTime() - 4 * 60_000), now)).toBe('il y a 4 min');
    expect(formatRelative(new Date(now.getTime() - 2 * 3_600_000), now)).toBe('il y a 2 h');
    expect(formatRelative(new Date('2026-11-03T16:20:00+01:00'), now)).toBe('hier');
    expect(formatRelative(new Date('2026-11-02T21:05:00+01:00'), now)).toBe('lun.');
    expect(formatRelative(new Date('2026-10-28T09:40:00+01:00'), now)).toBe('28 oct.');
    expect(formatAge(new Date(now.getTime() - 3 * 60_000), now)).toBe('3 min');
  });

  it('formats durations', () => {
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(12 * 60_000)).toBe('12 min');
    expect(formatDuration(65 * 60_000)).toBe('1 h 05');
    expect(formatDuration(160 * 60_000)).toBe('2 h 40');
  });

  it('formats long dates', () => {
    expect(formatLongDate(now)).toBe('Mercredi 4 novembre 2026');
  });

  it('formats sizes and percentages with regular spaces', () => {
    expect(formatPercent(23)).toBe('23 %');
    expect(formatUsage(5.1 * 1024 ** 3, 16 * 1024 ** 3)).toBe('5,1 / 16 Go');
    expect(formatUsage(61 * 1024 ** 3, 160 * 1024 ** 3)).toBe('61 / 160 Go');
    expect(formatBytes(2.4 * 1024 ** 3)).toBe('2,4 Go');
  });

  it('shortens shas and builds initials', () => {
    expect(shortSha('a3f9c12e45b')).toBe('a3f9c12');
    expect(initials('Nezar')).toBe('NZ');
    expect(initials('Ethan Ngo')).toBe('EN');
  });
});
