import { notifications } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/server/auth/session';
import { closeTestDb, prepareTestDatabase, resetTables } from '@/server/preferences/test/db';
import { useTestEncryptionKey } from '@/server/tenancy/test/db';
import { createTestAccount, type TestAccount } from '@/server/tenancy/test/fixtures';

/*
 * Notification routes per account (docs/MULTICOMPTE.md §9), against PostgreSQL
 * (`nuera_w5_settings_notif`): each account lists, counts and reads its own notifications only — the
 * ids of another account's notifications are answered like unknown ones (nothing changed, not counted).
 */

const state = vi.hoisted(() => ({ current: null as CurrentUser | null }));

vi.mock('@/server/auth/session', async () => {
  const { AppError } = await import('@/server/errors');
  return {
    getCurrentUser: async () => state.current,
    requireUser: async () => state.current,
    requireUserForApi: async () => {
      if (!state.current) throw new AppError('UNAUTHORIZED');
      return state.current;
    },
    isInstanceAdmin: (u: CurrentUser) => u.role === 'owner' || u.role === 'admin',
  };
});

type Handler = (request: NextRequest, context: { params: Promise<unknown> }) => Promise<Response>;
const ORIGIN = 'http://localhost:3800';

async function call(handler: Handler, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, host: 'localhost:3800' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return handler(
    new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }),
    { params: Promise.resolve({}) },
  );
}

let a: TestAccount;
let b: TestAccount;
let ofA: string[];
let ofB: string[];

async function db() {
  return (await import('@/server/db')).db;
}

beforeAll(async () => {
  useTestEncryptionKey();
  await prepareTestDatabase('notif');
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  vi.stubEnv('APP_URL', ORIGIN);
  a = await resetTables();
  b = await createTestAccount({ role: 'member', name: 'Lina Moreau', email: 'lina@example.test', environment: { configSource: 'db', name: 'VPS-4' } });
  const rows = await (await db())
    .insert(notifications)
    .values([
      { userId: a.user.id, spaceId: a.space.id, kind: 'session_finished', severity: 'success', title: 'A · terminée' },
      { userId: a.user.id, spaceId: a.space.id, kind: 'permission_request', severity: 'warning', title: 'A · autorisation' },
      { userId: b.user.id, spaceId: b.space.id, kind: 'server', severity: 'danger', title: 'B · serveur' },
    ])
    .returning({ id: notifications.id, userId: notifications.userId });
  ofA = rows.filter((row) => row.userId === a.user.id).map((row) => row.id);
  ofB = rows.filter((row) => row.userId === b.user.id).map((row) => row.id);
  state.current = b.user;
});

const routes = async () => ({
  list: (await import('./route')).GET as Handler,
  counts: (await import('./counts/route')).GET as Handler,
  read: (await import('./read/route')).POST as Handler,
});

describe('notifications per account', () => {
  it('lists and counts the signed-in account only', async () => {
    const { list, counts } = await routes();
    const listed = (await (await call(list, '/api/notifications')).json()) as { items: Array<{ title: string }>; counts: { unread: number } };
    expect(listed.items.map((item) => item.title)).toEqual(['B · serveur']);
    expect(listed.counts.unread).toBe(1);
    expect(await (await call(counts, '/api/notifications/counts')).json()).toMatchObject({ unread: 1, total: 1 });

    state.current = a.user;
    const ofOwner = (await (await call(list, '/api/notifications?unread=1')).json()) as { items: Array<{ title: string }> };
    expect(ofOwner.items.map((item) => item.title).sort()).toEqual(['A · autorisation', 'A · terminée']);
  });

  it("reads another account's ids exactly like unknown ones: nothing changed, nothing counted", async () => {
    const { read } = await routes();
    for (const ids of [ofA, [crypto.randomUUID()]]) {
      const response = await call(read, '/api/notifications/read', { method: 'POST', body: { ids } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ updated: 0, counts: expect.objectContaining({ unread: 1 }) });
    }
    const rowsOfA = await (await db()).select().from(notifications).where(eq(notifications.userId, a.user.id));
    expect(rowsOfA.every((row) => row.readAt === null)).toBe(true);

    expect(await (await call(read, '/api/notifications/read', { method: 'POST', body: { ids: ofB } })).json()).toMatchObject({ updated: 1, counts: { unread: 0 } });
  });

  it("« Tout marquer comme lu » never reaches another account's notifications", async () => {
    const { read } = await routes();
    expect(await (await call(read, '/api/notifications/read', { method: 'POST', body: { all: true } })).json()).toMatchObject({ updated: 1 });
    const rowsOfA = await (await db()).select().from(notifications).where(eq(notifications.userId, a.user.id));
    expect(rowsOfA.every((row) => row.readAt === null)).toBe(true);
  });

  it('works without a server, refuses a signed-out request and a foreign origin', async () => {
    const c = await createTestAccount({ role: 'member', name: 'Sans Serveur', environment: false });
    state.current = c.user;
    const { list, read } = await routes();
    expect((await call(list, '/api/notifications')).status).toBe(200);
    state.current = null;
    expect((await call(list, '/api/notifications')).status).toBe(401);
    state.current = b.user;
    const foreign = await read(
      new NextRequest(`${ORIGIN}/api/notifications/read`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', host: 'localhost:3800', 'content-type': 'application/json' },
        body: JSON.stringify({ all: true }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(foreign.status).toBe(403);
    const rowsOfB = await (await db()).select().from(notifications).where(eq(notifications.userId, b.user.id));
    expect(rowsOfB.every((row) => row.readAt === null)).toBe(true);
  });
});
