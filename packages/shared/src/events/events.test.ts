import { describe, expect, it } from 'vitest';
import {
  encodeHeartbeat,
  encodeSseEvent,
  encodeStreamHello,
  formatShortDuration,
  formatTestCounts,
  formatToolSummary,
  NotificationCreatedSchema,
  parseRunnerEvent,
  PublishEventRequestSchema,
} from './index';

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

describe('multi-account events', () => {
  const ENV_ID = '6f1c0b39-9f4c-4c1f-9c2e-8a8a2b0c1d2e';
  const data = (frame: string) => frame.split('\n').find((l) => l.startsWith('data: '))!.slice(6);

  it('stream.hello announces the account (and its server) without moving Last-Event-ID', () => {
    const frame = encodeStreamHello({ userId: 'user_123', environmentId: ENV_ID }, new Date('2026-11-05T10:00:00.000Z'));
    expect(frame).not.toContain('id:');
    expect(parseRunnerEvent(data(frame))).toEqual({
      seq: 0,
      type: 'stream.hello',
      at: '2026-11-05T10:00:00.000Z',
      data: { userId: 'user_123', environmentId: ENV_ID },
    });
    expect(parseRunnerEvent(data(encodeStreamHello({ userId: 'user_123', environmentId: null })))?.data).toEqual({
      userId: 'user_123',
      environmentId: null,
    });
    expect(parseRunnerEvent(JSON.stringify({ seq: 0, type: 'stream.hello', at: 'x', data: { userId: '', environmentId: null } }))).toBeNull();
    expect(parseRunnerEvent(JSON.stringify({ seq: 0, type: 'stream.hello', at: 'x', data: { userId: 'u' } }))).toBeNull();
  });

  it('notification.created may name its server; older payloads stay valid', () => {
    const base = {
      id: null,
      kind: 'claude_disconnected',
      severity: 'danger',
      title: 'Claude Code est déconnecté',
      body: null,
      href: null,
      projectId: null,
      sessionId: null,
    } as const;
    expect(NotificationCreatedSchema.parse(base).environmentId).toBeUndefined();
    expect(NotificationCreatedSchema.parse({ ...base, environmentId: ENV_ID }).environmentId).toBe(ENV_ID);
    expect(NotificationCreatedSchema.parse({ ...base, environmentId: null }).environmentId).toBeNull();
    expect(NotificationCreatedSchema.safeParse({ ...base, environmentId: 'vps-3' }).success).toBe(false);
    expect(PublishEventRequestSchema.parse({ type: 'notification.created', data: { ...base, environmentId: ENV_ID } }).data.environmentId).toBe(
      ENV_ID,
    );
    const event = { seq: 7, type: 'notification.created' as const, at: '2026-11-05T10:00:00.000Z', data: { ...base, environmentId: ENV_ID } };
    expect(parseRunnerEvent(data(encodeSseEvent(event)))).toEqual(event);
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
