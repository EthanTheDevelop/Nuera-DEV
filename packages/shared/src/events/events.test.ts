import { describe, expect, it } from 'vitest';
import { encodeHeartbeat, encodeSseEvent, formatShortDuration, formatTestCounts, formatToolSummary, parseRunnerEvent } from './index';

describe('SSE wire format', () => {
  it('round-trips an event through encode/parse', () => {
    const event = {
      seq: 1730000000000001,
      type: 'terminal.data' as const,
      at: '2026-11-05T10:00:00.000Z',
      data: { terminalId: 'abcdefghijkl', data: '\u001b[32mok\u001b[0m\r\n' },
    };
    const frame = encodeSseEvent(event);
    expect(frame.startsWith('id: 1730000000000001\ndata: ')).toBe(true);
    const data = frame.split('\n').find((l) => l.startsWith('data: '))!.slice(6);
    expect(parseRunnerEvent(data)).toEqual(event);
  });

  it('heartbeats carry no id', () => {
    expect(encodeHeartbeat()).not.toContain('id:');
    expect(parseRunnerEvent(encodeHeartbeat().slice(6).trim())?.type).toBe('heartbeat');
  });

  it('rejects malformed events', () => {
    expect(parseRunnerEvent('{"type":"nope"}')).toBeNull();
    expect(parseRunnerEvent('not json')).toBeNull();
  });
});

describe('tool meta formatting (Figma copy)', () => {
  it('formats the Workspace metas', () => {
    expect(formatToolSummary('done', { kind: 'lines', count: 212 })).toBe('212 lignes');
    expect(formatToolSummary('done', { kind: 'matches', count: 14, unit: 'files' })).toBe('14 fichiers');
    expect(formatToolSummary('done', { kind: 'diff', added: 46, removed: 12 })).toBe('+46 −12');
    expect(formatToolSummary('done', { kind: 'diff', added: 38, removed: 0 })).toBe('+38');
    expect(
      formatToolSummary('done', {
        kind: 'command',
        exitCode: 0,
        durationMs: 3200,
        interrupted: false,
        tests: { passed: 10, failed: 0, skipped: 0, running: 0, total: 10, durationMs: null, framework: 'vitest' },
      }),
    ).toBe('10 réussis · 3,2 s');
    expect(
      formatToolSummary('error', {
        kind: 'command',
        exitCode: 1,
        durationMs: 900,
        interrupted: false,
        tests: { passed: 8, failed: 2, skipped: 0, running: 0, total: 10, durationMs: null, framework: 'vitest' },
      }),
    ).toBe('code 1 · 2 échecs');
    expect(formatToolSummary('running', null)).toBe('en cours');
    expect(formatToolSummary('denied', null)).toBe('refusé');
  });

  it('formats durations and test counts', () => {
    expect(formatShortDuration(3200)).toBe('3,2 s');
    expect(formatShortDuration(12_400)).toBe('12 s');
    expect(formatShortDuration(7 * 60_000)).toBe('7 min');
    expect(formatTestCounts({ passed: 10, failed: 0, total: 10 })).toBe('10 / 10 réussis');
    expect(formatTestCounts({ passed: 22, failed: 1, total: 24 })).toBe('22 / 24 réussis · 1 échec');
  });
});
