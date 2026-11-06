import { randomUUID } from 'node:crypto';
import { notifications, projects, sessions, user } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { sendPush, SendPushResult } from '@/server/push';
import { dropSuiteDatabase, pgAvailable, prepareSuiteDatabase, resetAccounts, type TwoAccounts } from './test/db';
import type { UserEvent } from './user-events';

/**
 * Notification centre per recipient (docs/MULTICOMPTE.md §9): one row per account, dedup per
 * account, readers scoped to one account, a space's notification only for its members, pushes only
 * to the recipient's devices, live events only on the recipient's channel.
 */

const SUITE = 'notifications';
const available = await pgAvailable('notifications.test');

const pushed = (): SendPushResult => ({ sent: 1, pruned: 0, failed: 0, skipped: null });

describe('GitHub dedup keys (MULTICOMPTE.md §14.1)', () => {
  it('names the source, or « fallback » for GITHUB_FALLBACK_TOKEN', async () => {
    const { githubDedupKey, githubDedupPrefix } = await import('./index');
    expect(githubDedupKey('5d6b0a3e-0d7c-4d2e-9a43-1f0c2d3e4f5a', 'expired')).toBe('integration:github:5d6b0a3e-0d7c-4d2e-9a43-1f0c2d3e4f5a:expired');
    expect(githubDedupKey('fallback', 'expiring')).toBe('integration:github:fallback:expiring');
    expect(githubDedupPrefix('fallback')).toBe('integration:github:fallback:');
    expect(() => githubDedupPrefix('a:b')).toThrow();
    expect(() => githubDedupPrefix('')).toThrow();
  });
});

describe('user event channel', () => {
  it('delivers to the account it was published for only, and unsubscribes', async () => {
    const { publishUserEvent, subscribeUserEvents, userEventListenerCount } = await import('./user-events');
    const forA: UserEvent[] = [];
    const forB: UserEvent[] = [];
    const stopA = subscribeUserEvents('canal_a', (event) => forA.push(event));
    const stopB = subscribeUserEvents('canal_b', (event) => forB.push(event));
    const failing = subscribeUserEvents('canal_a', () => {
      throw new Error('écouteur cassé');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    publishUserEvent('canal_a', { type: 'notification.read', at: new Date().toISOString(), data: { all: true } });
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    failing();
    stopA();
    stopA();
    expect(userEventListenerCount('canal_a')).toBe(0);
    publishUserEvent('canal_a', { type: 'notification.read', at: new Date().toISOString(), data: { all: true } });
    expect(forA).toHaveLength(1);
    stopB();
    expect(() => subscribeUserEvents('', () => undefined)).toThrow();

    // The same function subscribed twice: two subscriptions, and a stale unsubscribe (already
    // called) never removes the newer one.
    const seen: UserEvent[] = [];
    const listener = (event: UserEvent) => seen.push(event);
    const first = subscribeUserEvents('canal_c', listener);
    first();
    const second = subscribeUserEvents('canal_c', listener);
    first();
    publishUserEvent('canal_c', { type: 'notification.read', at: new Date().toISOString(), data: { all: true } });
    expect(seen).toHaveLength(1);
    const third = subscribeUserEvents('canal_c', listener);
    expect(userEventListenerCount('canal_c')).toBe(2);
    publishUserEvent('canal_c', { type: 'notification.read', at: new Date().toISOString(), data: { all: true } });
    expect(seen).toHaveLength(3);
    second();
    third();
    expect(userEventListenerCount('canal_c')).toBe(0);
  });
});

describe.skipIf(!available)('notifications per recipient', () => {
  let accounts: TwoAccounts;

  beforeAll(async () => {
    await prepareSuiteDatabase(SUITE);
  });

  afterAll(async () => {
    await dropSuiteDatabase(SUITE);
  });

  beforeEach(async () => {
    accounts = await resetAccounts();
  });

  async function rows() {
    const { db } = await import('@/server/db');
    return db.select().from(notifications);
  }

  it('keeps one unread notification per recipient and dedupKey and pushes only the first one, to that recipient', async () => {
    const { createNotification } = await import('./index');
    const { a } = accounts;
    const sendPushImpl = vi.fn<typeof sendPush>(async () => pushed());
    const first = await createNotification(
      { kind: 'permission_request', severity: 'warning', title: 'Tests e2e du devis attend votre accord', href: '/workspace/x', dedupKey: 'permission:1' },
      { spaceId: a.spaceId, userIds: [a.userId] },
      { sendPushImpl },
    );
    expect(first.created).toBe(1);
    expect(first.recipients).toHaveLength(1);
    expect(first.recipients[0]).toMatchObject({ userId: a.userId, created: true });
    expect(first.recipients[0]!.notification.pushedAt).not.toBeNull();
    expect(first.recipients[0]!.notification.spaceId).toBe(a.spaceId);
    const second = await createNotification(
      { kind: 'permission_request', severity: 'warning', title: 'Tests e2e du devis attend toujours votre accord', dedupKey: 'permission:1' },
      { spaceId: a.spaceId, userIds: [a.userId] },
      { sendPushImpl },
    );
    expect(second.created).toBe(0);
    expect(second.recipients[0]!.created).toBe(false);
    expect(second.recipients[0]!.notification.id).toBe(first.recipients[0]!.notification.id);
    expect(second.recipients[0]!.notification.title).toBe('Tests e2e du devis attend toujours votre accord');
    expect(sendPushImpl).toHaveBeenCalledTimes(1);
    expect(sendPushImpl.mock.calls[0]?.[0]).toMatchObject({ title: 'Tests e2e du devis attend votre accord', url: '/workspace/x', tag: 'permission:1', kind: 'permission_request' });
    expect(sendPushImpl.mock.calls[0]?.[1]).toEqual({ userIds: [a.userId] });
    expect(await rows()).toHaveLength(1);
  });

  it('dedups per recipient: the same key for two accounts gives two rows, each pushed to its own account', async () => {
    const { createNotification, getNotificationCounts } = await import('./index');
    const { a, b } = accounts;
    const sendPushImpl = vi.fn<typeof sendPush>(async () => pushed());
    await createNotification({ kind: 'claude_disconnected', severity: 'danger', title: 'Claude Code est déconnecté', dedupKey: 'claude:auth' }, { spaceId: a.spaceId, userIds: [a.userId] }, { sendPushImpl });
    const forB = await createNotification({ kind: 'claude_disconnected', severity: 'danger', title: 'Claude Code est déconnecté', dedupKey: 'claude:auth' }, { spaceId: b.spaceId, userIds: [b.userId] }, { sendPushImpl });
    // B's notification is new even though A has an unread one with the same key.
    expect(forB.created).toBe(1);
    expect(await rows()).toHaveLength(2);
    expect(sendPushImpl.mock.calls.map((call) => call[1].userIds)).toEqual([[a.userId], [b.userId]]);
    expect((await getNotificationCounts(a.userId)).unread).toBe(1);
    expect((await getNotificationCounts(b.userId)).unread).toBe(1);
  });

  it("scopes the key of a server's event to that server: the same key from two servers never merges, one server's alerts still do", async () => {
    const { createNotification, getNotificationCounts, serverDedupKey } = await import('./index');
    const { a } = accounts;
    const unassigned = randomUUID();
    expect(serverDedupKey(unassigned, 'claude:auth')).toBe(`server:${unassigned}:claude:auth`);
    expect(serverDedupKey(unassigned, `server:${unassigned}:claude:auth`)).toBe(`server:${unassigned}:claude:auth`);
    const event = { kind: 'claude_disconnected', severity: 'danger', title: 'Claude Code est déconnecté', dedupKey: 'claude:auth' } as const;
    // An administrator receives the alerts of an unassigned server AND of their own server.
    const fromPending = await createNotification(event, { spaceId: null, userIds: [a.userId], environmentId: unassigned }, { push: false });
    const fromOwn = await createNotification(event, { spaceId: a.spaceId, userIds: [a.userId], environmentId: a.environmentId }, { push: false });
    expect([fromPending.created, fromOwn.created]).toEqual([1, 1]);
    expect((await rows()).map((row) => row.dedupKey).sort()).toEqual([`server:${a.environmentId}:claude:auth`, `server:${unassigned}:claude:auth`].sort());
    // The unassigned server is then assigned to the space: its alert keeps merging into the same row.
    const again = await createNotification({ ...event, title: 'Claude Code est toujours déconnecté' }, { spaceId: a.spaceId, userIds: [a.userId], environmentId: unassigned }, { push: false });
    expect(again.created).toBe(0);
    expect(again.recipients[0]!.notification).toMatchObject({ id: fromPending.recipients[0]!.notification.id, spaceId: a.spaceId });
    expect((await getNotificationCounts(a.userId)).unread).toBe(2);
  });

  it('creates a new notification once the previous one was read', async () => {
    const { createNotification, markNotificationsRead } = await import('./index');
    const { a } = accounts;
    const sendPushImpl = vi.fn<typeof sendPush>(async () => pushed());
    const target = { spaceId: a.spaceId, userIds: [a.userId] };
    const first = await createNotification({ kind: 'session_finished', title: 'Session terminée', dedupKey: 'session:1:end' }, target, { sendPushImpl });
    expect(await markNotificationsRead(a.userId, [first.recipients[0]!.notification.id])).toBe(1);
    const again = await createNotification({ kind: 'session_finished', title: 'Session terminée', dedupKey: 'session:1:end' }, target, { sendPushImpl });
    expect(again.created).toBe(1);
    expect(again.recipients[0]!.notification.id).not.toBe(first.recipients[0]!.notification.id);
    expect(sendPushImpl).toHaveBeenCalledTimes(2);
  });

  it('serialises concurrent writers of the same key (one row, one push)', async () => {
    const { createNotification } = await import('./index');
    const { a } = accounts;
    const sendPushImpl = vi.fn<typeof sendPush>(async () => pushed());
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createNotification({ kind: 'server', title: `VPS-3 ne répond pas (${index})`, dedupKey: 'server:down' }, { spaceId: a.spaceId, userIds: [a.userId] }, { sendPushImpl }),
      ),
    );
    expect(results.reduce((sum, result) => sum + result.created, 0)).toBe(1);
    expect(sendPushImpl).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
  });

  it('sends a space notification only to members of that space, never to a deleted account', async () => {
    const { createNotification } = await import('./index');
    const { db } = await import('@/server/db');
    const { a, b } = accounts;
    // B is not a member of A's space: skipped (the caller's mistake never leaks A's event to B).
    const result = await createNotification({ kind: 'server', title: 'VPS-3 redémarré' }, { spaceId: a.spaceId, userIds: [a.userId, b.userId, a.userId] }, { push: false });
    expect(result.recipients.map((recipient) => recipient.userId)).toEqual([a.userId]);
    // Instance alert (no space): any account may receive it, except a deleted one.
    await db.update(user).set({ deletedAt: new Date() }).where(eq(user.id, b.userId));
    const instance = await createNotification({ kind: 'security', title: 'Alerte instance' }, { spaceId: null, userIds: [a.userId, b.userId, 'compte-inconnu'] }, { push: false });
    expect(instance.recipients.map((recipient) => recipient.userId)).toEqual([a.userId]);
    expect(instance.recipients[0]!.notification.spaceId).toBeNull();
    const empty = await createNotification({ kind: 'security', title: 'Personne' }, { userIds: [] }, { push: false });
    expect(empty).toEqual({ recipients: [], created: 0 });
  });

  it("keeps project and session references only when they belong to the notification's space", async () => {
    const { createNotification } = await import('./index');
    const { db } = await import('@/server/db');
    const { a, b } = accounts;
    const [projectA] = await db
      .insert(projects)
      .values({
        spaceId: a.spaceId,
        environmentId: a.environmentId!,
        name: 'crm-core',
        slug: 'crm-core',
        githubFullName: 'nuera/crm-core',
        cloneUrl: 'https://github.com/nuera/crm-core.git',
        path: '/srv/dev/crm-core',
      })
      .returning({ id: projects.id });
    const [sessionA] = await db
      .insert(sessions)
      .values({ id: randomUUID(), projectId: projectA!.id, environmentId: a.environmentId!, title: 'Session A' })
      .returning({ id: sessions.id });
    const own = await createNotification({ kind: 'session_finished', title: 'fini', projectId: projectA!.id, sessionId: sessionA!.id }, { spaceId: a.spaceId, userIds: [a.userId] }, { push: false });
    expect(own.recipients[0]!.notification).toMatchObject({ projectId: projectA!.id, sessionId: sessionA!.id });
    // The same ids claimed for B's space are dropped (another space's resource is « unknown »).
    const forged = await createNotification({ kind: 'session_finished', title: 'fini', projectId: projectA!.id, sessionId: sessionA!.id }, { spaceId: b.spaceId, userIds: [b.userId] }, { push: false });
    expect(forged.recipients[0]!.notification).toMatchObject({ projectId: null, sessionId: null });
  });

  it("isolates readers: A never lists, counts, reads, opens or resolves B's notifications", async () => {
    const { createNotification, getNotification, getNotificationCounts, listNotifications, markAllNotificationsRead, markNotificationsRead, resolveNotifications } = await import('./index');
    const { a, b } = accounts;
    const opts = { push: false };
    const ta = { spaceId: a.spaceId, userIds: [a.userId] };
    const tb = { spaceId: b.spaceId, userIds: [b.userId] };
    const okA = await createNotification({ kind: 'operation_succeeded', severity: 'success', title: 'A' }, ta, opts);
    await createNotification({ kind: 'integration_expired', severity: 'danger', title: 'B', dedupKey: 'integration:github:src-a:expired' }, ta, opts);
    await createNotification({ kind: 'integration_expiring', severity: 'warning', title: 'C', dedupKey: 'integration:coolify:expiring' }, ta, opts);
    const forB = await createNotification({ kind: 'integration_expired', severity: 'danger', title: 'B1', dedupKey: 'integration:github:src-a:expired' }, tb, opts);
    await createNotification({ kind: 'server', severity: 'info', title: 'B2' }, tb, opts);
    const idB = forB.recipients[0]!.notification.id;

    await markNotificationsRead(a.userId, [okA.recipients[0]!.notification.id]);
    const list = await listNotifications(a.userId);
    expect(list.items.map((item) => item.title)).toEqual(['C', 'B', 'A']);
    expect(list.counts).toMatchObject({ unread: 2, total: 3, unreadBySeverity: { danger: 1, warning: 1, success: 0, info: 0 } });
    expect((await listNotifications(b.userId)).items.map((item) => item.title).sort()).toEqual(['B1', 'B2']);
    // A malformed page size or offset falls back to the defaults instead of failing the query.
    expect((await listNotifications(a.userId, { limit: Number.NaN, offset: Number.NaN })).items).toHaveLength(3);

    // A cannot open or read B's notification: same answer as an unknown id.
    expect(await getNotification(a.userId, idB)).toBeNull();
    expect(await getNotification(a.userId, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await getNotification(b.userId, idB)).toMatchObject({ id: idB, title: 'B1' });
    expect(await markNotificationsRead(a.userId, [idB, 'pas-un-uuid'])).toBe(0);
    expect((await getNotificationCounts(b.userId)).unread).toBe(2);

    // Resolving in A's space leaves B's identical key untouched.
    expect(await resolveNotifications({ spaceId: a.spaceId }, 'integration:github:src-a:')).toBe(1);
    expect((await getNotificationCounts(a.userId)).unread).toBe(1);
    expect((await getNotification(b.userId, idB))?.read).toBe(false);

    // « Tout marquer comme lu » for A only.
    expect(await markAllNotificationsRead(a.userId)).toBe(1);
    expect((await getNotificationCounts(a.userId)).unread).toBe(0);
    expect((await getNotificationCounts(b.userId)).unread).toBe(2);
    expect(await markAllNotificationsRead('')).toBe(0);
    expect((await listNotifications('')).items).toHaveLength(0);
  });

  it('resolves instance alerts separately from space notifications, and escapes LIKE wildcards', async () => {
    const { createNotification, getNotificationCounts, resolveNotifications } = await import('./index');
    const { a } = accounts;
    await createNotification({ kind: 'server', title: 'instance', dedupKey: 'server:pending:down' }, { spaceId: null, userIds: [a.userId] }, { push: false });
    await createNotification({ kind: 'server', title: 'espace', dedupKey: 'server:own:down' }, { spaceId: a.spaceId, userIds: [a.userId] }, { push: false });
    expect(await resolveNotifications({ spaceId: a.spaceId }, 'server:%')).toBe(0);
    expect(await resolveNotifications({ spaceId: null }, 'server:')).toBe(1);
    expect((await getNotificationCounts(a.userId)).unread).toBe(1);
    expect(await resolveNotifications({ spaceId: a.spaceId, userIds: [] }, 'server:')).toBe(0);
    expect(await resolveNotifications({ spaceId: 'pas-un-uuid' }, 'server:')).toBe(0);
    expect(await resolveNotifications({ spaceId: a.spaceId, userIds: [a.userId] }, 'server:')).toBe(1);
    expect((await getNotificationCounts(a.userId)).unread).toBe(0);
  });

  it('a refresh describes the latest event entirely (space included): resolving that space clears it', async () => {
    const { createNotification, getNotificationCounts, resolveNotifications } = await import('./index');
    const { a } = accounts;
    const first = await createNotification({ kind: 'server', title: 'instance', dedupKey: 'server:x:down' }, { spaceId: null, userIds: [a.userId] }, { push: false });
    const second = await createNotification({ kind: 'server', title: 'espace', dedupKey: 'server:x:down' }, { spaceId: a.spaceId, userIds: [a.userId] }, { push: false });
    expect(second.recipients[0]!.notification).toMatchObject({ id: first.recipients[0]!.notification.id, title: 'espace', spaceId: a.spaceId });
    expect(await resolveNotifications({ spaceId: null }, 'server:')).toBe(0);
    expect(await resolveNotifications({ spaceId: a.spaceId }, 'server:')).toBe(1);
    expect((await getNotificationCounts(a.userId)).unread).toBe(0);
  });

  it("publishes creations and reads on the recipient's channel only", async () => {
    const { createNotification, markAllNotificationsRead, markNotificationsRead, resolveNotifications } = await import('./index');
    const { subscribeUserEvents } = await import('./user-events');
    const { a, b } = accounts;
    const forA: UserEvent[] = [];
    const forB: UserEvent[] = [];
    const stopA = subscribeUserEvents(a.userId, (event) => forA.push(event));
    const stopB = subscribeUserEvents(b.userId, (event) => forB.push(event));
    try {
      const created = await createNotification(
        { kind: 'permission_request', severity: 'warning', title: 'Accord attendu', href: '/workspace/s', dedupKey: 'permission:9' },
        { spaceId: a.spaceId, userIds: [a.userId], environmentId: a.environmentId },
        { push: false },
      );
      const id = created.recipients[0]!.notification.id;
      expect(forA).toEqual([
        expect.objectContaining({
          type: 'notification.created',
          data: expect.objectContaining({ id, title: 'Accord attendu', href: '/workspace/s', environmentId: a.environmentId }),
        }),
      ]);
      // A refresh (same key) is published with the same id: the bell replaces it.
      await createNotification(
        { kind: 'permission_request', severity: 'warning', title: 'Accord toujours attendu', dedupKey: 'permission:9' },
        { spaceId: a.spaceId, userIds: [a.userId], environmentId: a.environmentId },
        { push: false },
      );
      expect(forA[1]).toMatchObject({ type: 'notification.created', data: { id, title: 'Accord toujours attendu' } });
      await markNotificationsRead(a.userId, [id]);
      expect(forA[2]).toMatchObject({ type: 'notification.read', data: { all: false, ids: [id] } });
      await createNotification({ kind: 'server', title: 'x', dedupKey: 'server:y' }, { spaceId: a.spaceId, userIds: [a.userId] }, { push: false });
      await resolveNotifications({ spaceId: a.spaceId }, 'server:');
      expect(forA[4]).toMatchObject({ type: 'notification.read', data: { all: false } });
      await createNotification({ kind: 'server', title: 'z' }, { spaceId: a.spaceId, userIds: [a.userId] }, { push: false });
      await markAllNotificationsRead(a.userId);
      expect(forA.at(-1)).toMatchObject({ type: 'notification.read', data: { all: true } });
      // Nothing about A ever reached B, and a read with nothing to read publishes nothing.
      await markAllNotificationsRead(b.userId);
      expect(forB).toHaveLength(0);
    } finally {
      stopA();
      stopB();
    }
  });

  it('a push failure never fails the notification', async () => {
    const { createNotification } = await import('./index');
    const { a } = accounts;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await createNotification(
      { kind: 'session_failed', title: 'Session arrêtée' },
      { spaceId: a.spaceId, userIds: [a.userId] },
      { sendPushImpl: async () => Promise.reject(new Error('service push indisponible')) },
    );
    expect(result.created).toBe(1);
    expect(result.recipients[0]!.notification.pushedAt).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it('finds the recipients of a server event: its space members, or the administrators when unassigned', async () => {
    const { environmentRecipients, instanceAdminRecipients, spaceRecipients } = await import('./index');
    const { db } = await import('@/server/db');
    const { seedEnvironment } = await import('@nuera/db/test');
    const { a, b } = accounts;
    expect(await spaceRecipients(a.spaceId)).toEqual([a.userId]);
    expect(await spaceRecipients('pas-un-uuid')).toEqual([]);
    expect(await environmentRecipients(b.environmentId!)).toEqual({ spaceId: b.spaceId, userIds: [b.userId] });
    const pending = await seedEnvironment(db, { spaceId: null, name: 'VPS-9' });
    expect(await environmentRecipients(pending)).toEqual({ spaceId: null, userIds: [a.userId] });
    expect(await environmentRecipients('00000000-0000-4000-8000-000000000000')).toBeNull();
    // A disabled administrator gets no instance alert.
    await db.update(user).set({ role: 'admin' }).where(eq(user.id, b.userId));
    expect((await instanceAdminRecipients()).sort()).toEqual([a.userId, b.userId].sort());
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, b.userId));
    expect(await instanceAdminRecipients()).toEqual([a.userId]);
  });

  it('validates the input (relative href only, known kind, valid target)', async () => {
    const { createNotification } = await import('./index');
    const { a } = accounts;
    const target = { spaceId: a.spaceId, userIds: [a.userId] };
    await expect(createNotification({ kind: 'server', title: 'x', href: 'https://evil.example' }, target, { push: false })).rejects.toThrow();
    await expect(createNotification({ kind: 'server', title: 'x', href: '//evil.example' }, target, { push: false })).rejects.toThrow();
    await expect(createNotification({ kind: 'nope' as 'server', title: 'x' }, target, { push: false })).rejects.toThrow();
    await expect(createNotification({ kind: 'server', title: 'x' }, { spaceId: 'pas-un-uuid', userIds: [a.userId] }, { push: false })).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
  });
});
