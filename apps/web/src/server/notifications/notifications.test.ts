import { notifications } from '@nuera/db/schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, prepareTestDatabase, resetTables } from '@/server/integrations/test/db';
import type { sendPush, SendPushResult } from '@/server/push';

beforeAll(async () => {
  await prepareTestDatabase('notifications');
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTables();
});

const pushed = (): SendPushResult => ({ sent: 1, pruned: 0, failed: 0, skipped: null });

describe('notifications', () => {
  it('keeps one unread notification per dedupKey and pushes only the first one', async () => {
    const { createNotification } = await import('./index');
    const sendPushImpl = vi.fn<typeof sendPush>(async () => pushed());
    const first = await createNotification(
      { kind: 'permission_request', severity: 'warning', title: 'Tests e2e du devis attend votre accord', href: '/sessions/x', dedupKey: 'permission:1' },
      { sendPushImpl },
    );
    expect(first.created).toBe(true);
    expect(first.notification.pushedAt).not.toBeNull();
    const second = await createNotification(
      { kind: 'permission_request', severity: 'warning', title: 'Tests e2e du devis attend toujours votre accord', dedupKey: 'permission:1' },
      { sendPushImpl },
    );
    expect(second.created).toBe(false);
    expect(second.notification.id).toBe(first.notification.id);
    expect(second.notification.title).toBe('Tests e2e du devis attend toujours votre accord');
    expect(sendPushImpl).toHaveBeenCalledTimes(1);
    expect(sendPushImpl.mock.calls[0]?.[0]).toMatchObject({ title: 'Tests e2e du devis attend votre accord', url: '/sessions/x', tag: 'permission:1', kind: 'permission_request' });

    const { db } = await import('@/server/db');
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it('creates a new notification once the previous one was read', async () => {
    const { createNotification, markNotificationsRead } = await import('./index');
    const sendPushImpl = vi.fn<typeof sendPush>(async () => pushed());
    const first = await createNotification({ kind: 'session_finished', title: 'Session terminée', dedupKey: 'session:1:end' }, { sendPushImpl });
    expect(await markNotificationsRead([first.notification.id])).toBe(1);
    const again = await createNotification({ kind: 'session_finished', title: 'Session terminée', dedupKey: 'session:1:end' }, { sendPushImpl });
    expect(again.created).toBe(true);
    expect(again.notification.id).not.toBe(first.notification.id);
    expect(sendPushImpl).toHaveBeenCalledTimes(2);
  });

  it('serialises concurrent writers of the same key', async () => {
    const { createNotification } = await import('./index');
    const sendPushImpl = vi.fn<typeof sendPush>(async () => pushed());
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) => createNotification({ kind: 'server', title: `VPS-3 ne répond pas (${index})`, dedupKey: 'server:down' }, { sendPushImpl })),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const { db } = await import('@/server/db');
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it('lists unread first, counts by severity, marks all read and resolves by prefix', async () => {
    const { createNotification, getNotificationCounts, listNotifications, markAllNotificationsRead, markNotificationsRead, resolveNotifications } = await import('./index');
    const opts = { push: false };
    const a = await createNotification({ kind: 'operation_succeeded', severity: 'success', title: 'A' }, opts);
    await createNotification({ kind: 'integration_expired', severity: 'danger', title: 'B', dedupKey: 'integration:github:expired' }, opts);
    await createNotification({ kind: 'integration_expiring', severity: 'warning', title: 'C', dedupKey: 'integration:coolify:expiring' }, opts);
    await markNotificationsRead([a.notification.id]);
    const list = await listNotifications();
    expect(list.items.map((item) => item.title)).toEqual(['C', 'B', 'A']);
    expect(list.counts).toMatchObject({ unread: 2, total: 3, unreadBySeverity: { danger: 1, warning: 1, success: 0, info: 0 } });
    expect(await resolveNotifications('integration:github:')).toBe(1);
    expect((await getNotificationCounts()).unread).toBe(1);
    expect(await markAllNotificationsRead()).toBe(1);
    expect((await getNotificationCounts()).unread).toBe(0);
  });

  it('validates the input (relative href only, known kind)', async () => {
    const { createNotification } = await import('./index');
    await expect(createNotification({ kind: 'server', title: 'x', href: 'https://evil.example' }, { push: false })).rejects.toThrow();
    await expect(createNotification({ kind: 'server', title: 'x', href: '//evil.example' }, { push: false })).rejects.toThrow();
    await expect(createNotification({ kind: 'nope' as 'server', title: 'x' }, { push: false })).rejects.toThrow();
  });
});
