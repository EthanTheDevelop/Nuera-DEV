import { describe, expect, it } from 'vitest';
import type { ShellData } from '@/components/shell/types';
import { createRefreshGate, initialLiveState, liveEventsReducer, liveStreamUrl, safeNotificationHref, type LiveState } from './useLiveEvents';

const shell: ShellData = {
  user: { name: 'Owner Test', firstName: 'Owner', twoFactorEnabled: true },
  server: {
    name: 'srv-test',
    location: null,
    statusUrl: null,
    availability: 'available',
    metrics: null,
    lastContactAt: '2026-11-04T10:00:00.000Z',
  },
  claude: { state: 'connected', version: '2.1.0', checkedAt: '2026-11-04T10:00:00.000Z', error: null },
  sessions: { activeIds: ['a'], max: 4 },
  notifications: {
    items: [
      { id: 'n1', kind: 'session_finished', severity: 'success', title: 't1', body: null, href: null, read: false, createdAt: '2026-11-04T10:00:00.000Z' },
      { id: 'n2', kind: 'server', severity: 'info', title: 't2', body: null, href: null, read: true, createdAt: '2026-11-04T09:00:00.000Z' },
    ],
    unread: 1,
  },
  generatedAt: '2026-11-04T10:00:00.000Z',
};

const base = (): LiveState => initialLiveState(shell);

describe('liveEventsReducer', () => {
  it('starts from the server snapshot', () => {
    const s = base();
    expect(s.connection).toBe('connecting');
    expect(s.runner).toBe('available');
    expect(s.activeSessionIds).toEqual(['a']);
    expect(s.notifications.unread).toBe(1);
  });

  it('tracks active sessions from session.status (add once, remove)', () => {
    let s = liveEventsReducer(base(), { type: 'session', id: 'b', active: true, at: '2026-11-04T10:01:00.000Z' });
    s = liveEventsReducer(s, { type: 'session', id: 'b', active: true, at: '2026-11-04T10:02:00.000Z' });
    expect(s.activeSessionIds).toEqual(['a', 'b']);
    s = liveEventsReducer(s, { type: 'session', id: 'a', active: false, at: '2026-11-04T10:03:00.000Z' });
    expect(s.activeSessionIds).toEqual(['b']);
  });

  it('counts a new notification once and keeps dedup updates unread-neutral', () => {
    const item = { id: 'n3', kind: 'permission_request', severity: 'warning' as const, title: 'x', body: null, href: null, read: false, createdAt: '2026-11-04T10:05:00.000Z' };
    let s = liveEventsReducer(base(), { type: 'notification', item });
    expect(s.notifications.unread).toBe(2);
    expect(s.notifications.items[0]?.id).toBe('n3');
    s = liveEventsReducer(s, { type: 'notification', item: { ...item, title: 'y' } });
    expect(s.notifications.unread).toBe(2);
    expect(s.notifications.items.filter((n) => n.id === 'n3')).toHaveLength(1);
  });

  it('marks notifications read (some / all)', () => {
    let s = liveEventsReducer(base(), { type: 'read', ids: ['n1'] });
    expect(s.notifications.unread).toBe(0);
    expect(s.notifications.items.every((n) => n.read)).toBe(true);
    s = liveEventsReducer(base(), { type: 'read', ids: 'all' });
    expect(s.notifications.unread).toBe(0);
  });

  it('keeps the browser link « open » when the web app reports the runner down (T5, not W7)', () => {
    const s = liveEventsReducer(base(), { type: 'lost', nextRetryAt: 10, attempt: 1, runnerDown: true });
    expect(s.connection).toBe('open');
    const w7 = liveEventsReducer(base(), { type: 'lost', nextRetryAt: 10, attempt: 1, runnerDown: false });
    expect(w7.connection).toBe('reconnecting');
    expect(w7.nextRetryAt).toBe(10);
  });

  it('resets the back-off on a healthy signal', () => {
    let s = liveEventsReducer(base(), { type: 'lost', nextRetryAt: 10, attempt: 3, runnerDown: false });
    s = liveEventsReducer(s, { type: 'signal', at: 1234 });
    expect(s).toMatchObject({ connection: 'open', attempt: 0, nextRetryAt: null, lastSignalAt: 1234 });
  });

  it('records runner availability and the last contact', () => {
    const s = liveEventsReducer(base(), { type: 'runner', availability: 'unavailable' });
    expect(s.runner).toBe('unavailable');
    expect(s.lastRunnerContactAt).toBe('2026-11-04T10:00:00.000Z');
    const back = liveEventsReducer(s, { type: 'runner', availability: 'available', contactAt: '2026-11-04T10:10:00.000Z' });
    expect(back.lastRunnerContactAt).toBe('2026-11-04T10:10:00.000Z');
  });
});

describe('liveEventsReducer · sync with a newer server snapshot (router.refresh)', () => {
  const metrics = (sampledAt: string, cpuPercent: number) => ({
    cpuPercent,
    memoryUsedBytes: 1,
    memoryTotalBytes: 2,
    diskUsedBytes: null,
    diskTotalBytes: null,
    sampledAt,
  });

  it('takes the database truth (sessions, notifications) and a successful runner answer', () => {
    let s = liveEventsReducer(base(), { type: 'runner', availability: 'unavailable' });
    s = liveEventsReducer(s, { type: 'session', id: 'gone', active: true, at: '2026-11-04T10:05:00.000Z' });
    const snapshot: ShellData = {
      ...shell,
      server: { ...shell.server, availability: 'available', metrics: metrics('2026-11-04T10:20:00.000Z', 12), lastContactAt: '2026-11-04T10:20:00.000Z' },
      sessions: { activeIds: ['c'], max: 4 },
      notifications: { items: [], unread: 0 },
      generatedAt: '2026-11-04T10:20:00.000Z',
    };
    s = liveEventsReducer(s, { type: 'sync', snapshot });
    expect(s.runner).toBe('available');
    expect(s.activeSessionIds).toEqual(['c']);
    expect(s.notifications).toEqual({ items: [], unread: 0 });
    expect(s.metrics?.cpuPercent).toBe(12);
    expect(s.lastRunnerContactAt).toBe('2026-11-04T10:20:00.000Z');
  });

  it('keeps the live events received after the snapshot was read', () => {
    let s = liveEventsReducer(base(), { type: 'session', id: 'late', active: true, at: '2026-11-04T10:21:00.000Z' });
    s = liveEventsReducer(s, { type: 'session', id: 'a', active: false, at: '2026-11-04T10:21:30.000Z' });
    const item = { id: 'n9', kind: 'session_finished', severity: 'success' as const, title: 'fin', body: null, href: null, read: false, createdAt: '2026-11-04T10:22:00.000Z' };
    s = liveEventsReducer(s, { type: 'notification', item });
    const snapshot: ShellData = {
      ...shell,
      sessions: { activeIds: ['a', 'b'], max: 4 },
      notifications: { items: [], unread: 0 },
      generatedAt: '2026-11-04T10:20:00.000Z',
    };
    s = liveEventsReducer(s, { type: 'sync', snapshot });
    expect(s.activeSessionIds).toEqual(['b', 'late']);
    expect(s.notifications.items.map((n) => n.id)).toEqual(['n9']);
    expect(s.notifications.unread).toBe(1);
    // the replayed updates are consumed by the next snapshot that already contains them
    s = liveEventsReducer(s, { type: 'sync', snapshot: { ...snapshot, sessions: { activeIds: ['b', 'late'], max: 4 }, generatedAt: '2026-11-04T10:25:00.000Z' } });
    expect(s.sessionUpdates).toEqual({});
    expect(s.activeSessionIds).toEqual(['b', 'late']);
  });

  it('never lets a snapshot declare T5 nor erase newer live values', () => {
    let s = liveEventsReducer(base(), { type: 'metrics', metrics: metrics('2026-11-04T10:30:00.000Z', 40) });
    s = liveEventsReducer(s, { type: 'runner', availability: 'available', contactAt: '2026-11-04T10:30:00.000Z' });
    const snapshot: ShellData = {
      ...shell,
      server: { ...shell.server, availability: 'unavailable', metrics: metrics('2026-11-04T10:25:00.000Z', 5), lastContactAt: '2026-11-04T10:25:00.000Z' },
      claude: { state: 'unknown', version: null, checkedAt: null, error: null },
      generatedAt: '2026-11-04T10:31:00.000Z',
    };
    s = liveEventsReducer(s, { type: 'sync', snapshot });
    expect(s.runner).toBe('available');
    expect(s.metrics?.cpuPercent).toBe(40);
    expect(s.lastRunnerContactAt).toBe('2026-11-04T10:30:00.000Z');
    expect(s.claude.state).toBe('connected');
  });
});

describe('live stream helpers', () => {
  it('resumes the stream after the last event id (digits only)', () => {
    expect(liveStreamUrl('/api/stream/events', null)).toBe('/api/stream/events');
    expect(liveStreamUrl('/api/stream/events', '1793840430037001')).toBe('/api/stream/events?lastEventId=1793840430037001');
    expect(liveStreamUrl('/api/stream/events?x=1', '42')).toBe('/api/stream/events?x=1&lastEventId=42');
    expect(liveStreamUrl('/api/stream/events', '42&evil=1')).toBe('/api/stream/events');
  });

  it('only follows in-app paths from a live notification', () => {
    expect(safeNotificationHref('/sessions/abc?vue=session')).toBe('/sessions/abc?vue=session');
    expect(safeNotificationHref('https://example.test/phish')).toBeNull();
    expect(safeNotificationHref('//example.test')).toBeNull();
    expect(safeNotificationHref('javascript:alert(1)')).toBeNull();
    expect(safeNotificationHref('/\\example.test')).toBeNull();
    expect(safeNotificationHref(null)).toBeNull();
  });
});

describe('createRefreshGate (layout refresh under an intercepted route)', () => {
  const manual = () => {
    const tasks: Array<() => void> = [];
    let runs = 0;
    const gate = createRefreshGate(() => (runs += 1), (task) => tasks.push(task));
    const flush = () => tasks.splice(0).forEach((task) => task());
    return { gate, flush, runs: () => runs };
  };

  it('coalesces a burst of requests into one refresh', () => {
    const { gate, flush, runs } = manual();
    gate.request();
    gate.request();
    flush();
    expect(runs()).toBe(1);
  });

  it('holds the refresh while deferred and runs it once on the last release', () => {
    const { gate, flush, runs } = manual();
    const releaseModal = gate.defer();
    const releaseDrawer = gate.defer();
    gate.request();
    flush();
    expect(runs()).toBe(0);
    releaseModal();
    releaseModal(); // idempotent
    flush();
    expect(runs()).toBe(0);
    releaseDrawer();
    flush();
    expect(runs()).toBe(1);
  });

  it('does nothing on release when no refresh was asked; force ignores the deferral', () => {
    const { gate, flush, runs } = manual();
    const release = gate.defer();
    release();
    flush();
    expect(runs()).toBe(0);
    gate.defer();
    gate.request(true);
    flush();
    expect(runs()).toBe(1);
  });
});
