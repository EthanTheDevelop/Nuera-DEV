import { createECDH, randomBytes } from 'node:crypto';
import { auditLog, pushSubscriptions, session } from '@nuera/db/schema';
import { eq, like } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/server/auth/session';
import { closeTestDb, prepareTestDatabase, resetTables } from '@/server/preferences/test/db';
import { useTestEncryptionKey } from '@/server/tenancy/test/db';
import { createTestAccount, type TestAccount } from '@/server/tenancy/test/fixtures';

/*
 * Web Push routes per account (docs/MULTICOMPTE.md §9), against PostgreSQL (`nuera_w5_settings_push`):
 * one row per account and device, another account's device answered like an unknown one, the shared
 * browser told without naming the other account, only push service hosts accepted, and the renewal
 * of the service worker: only the signed-in account's row moves, nothing is written without a
 * session, and the answer is always 204.
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
const ORIGIN = 'https://dev.example.test';

async function call(handler: Handler, path: string, init: { method?: string; body?: unknown; origin?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = { host: 'dev.example.test' };
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return handler(
    new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }),
    { params: Promise.resolve({}) },
  );
}

function subscription(endpoint: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

function vapid() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
}

let a: TestAccount;
let b: TestAccount;
const KEYS = vapid();

async function db() {
  return (await import('@/server/db')).db;
}

beforeAll(async () => {
  useTestEncryptionKey();
  await prepareTestDatabase('push');
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  vi.stubEnv('APP_URL', ORIGIN);
  vi.stubEnv('VAPID_PUBLIC_KEY', KEYS.publicKey);
  vi.stubEnv('VAPID_PRIVATE_KEY', KEYS.privateKey);
  vi.stubEnv('VAPID_SUBJECT', 'mailto:dev@example.test');
  vi.stubEnv('BETTER_AUTH_SECRET', 'secret-de-test-0123456789abcdef0123456789');
  (await import('@/server/security/rate-limit')).rateLimiter.reset();
  a = await resetTables();
  b = await createTestAccount({ role: 'member', name: 'Lina Moreau', email: 'lina@example.test', environment: { configSource: 'db', name: 'VPS-4' } });
  // The web access of each signed-in account (a subscription lives as long as its access).
  for (const account of [a, b]) await openAccess(account.user.authSessionId, account.user.id);
  state.current = a.user;
});

async function openAccess(id: string, userId: string, times: { updatedAt?: Date } = {}) {
  const now = Date.now();
  await (await db()).insert(session).values({
    id,
    token: `jeton-${id}`,
    userId,
    createdAt: new Date(now - 60_000),
    updatedAt: times.updatedAt ?? new Date(now - 60_000),
    expiresAt: new Date(now + 30 * 86_400_000),
  });
}

const routes = async () => ({
  subscription: await import('./subscription/route'),
  renew: await import('./subscription/renew/route'),
  test: (await import('./test/route')).POST as Handler,
  config: (await import('./config/route')).GET as Handler,
});

const ENDPOINT = 'https://push.example.test/send/shared-browser';

describe('subscriptions per account', () => {
  it('files one row per account for a shared browser, and says the browser is shared (never by whom)', async () => {
    const { subscription: route } = await routes();
    const first = await call(route.POST as Handler, '/api/push/subscription', { method: 'POST', body: { ...subscription(ENDPOINT), deviceLabel: 'Poste partagé' } });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ deviceLabel: 'Poste partagé', sharedWithOtherAccount: false });

    state.current = b.user;
    const second = await call(route.POST as Handler, '/api/push/subscription', { method: 'POST', body: subscription(ENDPOINT) });
    const saved = (await second.json()) as Record<string, unknown>;
    expect(saved.sharedWithOtherAccount).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(a.user.id);

    const rows = await (await db()).select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, ENDPOINT));
    expect(rows.map((row) => row.userId).sort()).toEqual([a.user.id, b.user.id].sort());
    expect(rows.find((row) => row.userId === b.user.id)?.authSessionId).toBe(b.user.authSessionId);

    const listed = (await (await call(route.GET as Handler, `/api/push/subscription?endpoint=${encodeURIComponent(ENDPOINT)}`)).json()) as {
      subscribed: boolean;
      sharedWithOtherAccount: boolean;
      devices: Array<{ id: string }>;
    };
    expect(listed).toMatchObject({ subscribed: true, sharedWithOtherAccount: true });
    expect(listed.devices).toHaveLength(1);
  });

  it('never shows a device whose web access has ended as subscribed (nor the browser as shared because of it)', async () => {
    const { subscription: route } = await routes();
    await call(route.POST as Handler, '/api/push/subscription', { method: 'POST', body: subscription(ENDPOINT) });
    state.current = b.user;
    await call(route.POST as Handler, '/api/push/subscription', { method: 'POST', body: subscription(ENDPOINT) });
    // A's access ends outside of Nuera Dev's own sign-out (Better Auth endpoint, expiry, administration).
    await (await db()).delete(session).where(eq(session.id, a.user.authSessionId));
    const seenByB = (await (await call(route.GET as Handler, `/api/push/subscription?endpoint=${encodeURIComponent(ENDPOINT)}`)).json()) as Record<string, unknown>;
    expect(seenByB).toMatchObject({ subscribed: true, sharedWithOtherAccount: false });
    // B's reads never remove A's row.
    expect(await (await db()).select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, a.user.id))).toHaveLength(1);

    // A signs in again on this browser (a new access): « Activer » is offered again, the stale row goes.
    const again = { ...a.user, authSessionId: `${a.user.authSessionId}-nouveau` };
    await openAccess(again.authSessionId, a.user.id);
    state.current = again;
    const seenByA = (await (await call(route.GET as Handler, `/api/push/subscription?endpoint=${encodeURIComponent(ENDPOINT)}`)).json()) as {
      subscribed: boolean;
      sharedWithOtherAccount: boolean;
      devices: unknown[];
    };
    expect(seenByA).toMatchObject({ subscribed: false, sharedWithOtherAccount: true, devices: [] });
    expect(await (await db()).select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, a.user.id))).toEqual([]);
    // Turning it on again binds the device to the new access.
    await call(route.POST as Handler, '/api/push/subscription', { method: 'POST', body: subscription(ENDPOINT) });
    const [row] = await (await db()).select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, a.user.id));
    expect(row?.authSessionId).toBe(again.authSessionId);
  });

  it("answers another account's device like an unknown one: nothing deleted, no audit", async () => {
    const { subscription: route } = await routes();
    const created = (await (await call(route.POST as Handler, '/api/push/subscription', { method: 'POST', body: subscription(ENDPOINT) })).json()) as { id: string };
    state.current = b.user;
    const before = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'security.push_unsubscribed'));
    for (const body of [{ id: created.id }, { id: crypto.randomUUID() }, { endpoint: ENDPOINT }]) {
      const response = await call(route.DELETE as Handler, '/api/push/subscription', { method: 'DELETE', body });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ deleted: false });
    }
    expect(await (await db()).select().from(pushSubscriptions).where(eq(pushSubscriptions.id, created.id))).toHaveLength(1);
    expect(await (await db()).select().from(auditLog).where(eq(auditLog.action, 'security.push_unsubscribed'))).toEqual(before);
  });

  it('turning one account off keeps the browser subscribed for the other one', async () => {
    const { subscription: route } = await routes();
    await call(route.POST as Handler, '/api/push/subscription', { method: 'POST', body: subscription(ENDPOINT) });
    state.current = b.user;
    await call(route.POST as Handler, '/api/push/subscription', { method: 'POST', body: subscription(ENDPOINT) });
    const off = await call(route.DELETE as Handler, '/api/push/subscription', { method: 'DELETE', body: { endpoint: ENDPOINT } });
    expect(await off.json()).toEqual({ deleted: true, sharedWithOtherAccount: true });
    state.current = a.user;
    expect(await (await call(route.DELETE as Handler, '/api/push/subscription', { method: 'DELETE', body: { endpoint: ENDPOINT } })).json()).toEqual({
      deleted: true,
      sharedWithOtherAccount: false,
    });
  });

  it('sends the test notification to the signed-in account only', async () => {
    const { subscription: route, test } = await routes();
    await call(route.POST as Handler, '/api/push/subscription', { method: 'POST', body: subscription('https://push.example.test/send/a-only') });
    state.current = b.user;
    const result = (await (await call(test, '/api/push/test', { method: 'POST' })).json()) as { sent: number; skipped: string | null };
    expect(result).toMatchObject({ sent: 0, skipped: 'Aucun appareil abonné.' });
  });

  it('refuses an endpoint that is not a push service (422), without saving anything', async () => {
    const { subscription: route } = await routes();
    vi.stubEnv('NODE_ENV', 'production');
    const response = await call(route.POST as Handler, '/api/push/subscription', { method: 'POST', body: subscription('https://b-controlled.example/x') });
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).not.toContain('b-controlled');
    expect(await (await db()).select().from(pushSubscriptions)).toEqual([]);
  });

  it('requires a session for everything but the renewal', async () => {
    state.current = null;
    const { subscription: route, config } = await routes();
    expect((await call(route.GET as Handler, '/api/push/subscription')).status).toBe(401);
    expect((await call(config, '/api/push/config')).status).toBe(401);
  });
});

describe('renewal by the service worker', () => {
  async function subscribeBoth(endpoint: string) {
    const { subscription: route } = await routes();
    const keys: Record<string, { p256dh: string; auth: string }> = {};
    for (const account of [a, b]) {
      state.current = account.user;
      const body = subscription(endpoint);
      keys[account.user.id] = body.keys;
      await call(route.POST as Handler, '/api/push/subscription', { method: 'POST', body });
    }
    state.current = null;
    return keys;
  }

  async function renewAs(current: CurrentUser | null, body: unknown) {
    const { renew } = await routes();
    state.current = current;
    return call(renew.POST as Handler, '/api/push/subscription/renew', { method: 'POST', body });
  }

  it("moves only the signed-in account's row: another account of the browser keeps its endpoint and keys", async () => {
    const keys = await subscribeBoth(ENDPOINT);
    const next = subscription('https://push.example.test/send/renewed');
    const response = await renewAs(b.user, { oldEndpoint: ENDPOINT, subscription: next });
    expect(response.status).toBe(204);
    const rows = await (await db()).select().from(pushSubscriptions);
    expect(rows.map((row) => [row.userId, row.endpoint, row.p256dh]).sort()).toEqual(
      [
        [a.user.id, ENDPOINT, keys[a.user.id]!.p256dh],
        [b.user.id, next.endpoint, next.keys.p256dh],
      ].sort(),
    );
    const audits = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'security.push_renewed'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: b.user.id, subjectUserId: b.user.id });
  });

  it("never re-keys another account's row on the same endpoint", async () => {
    const keys = await subscribeBoth(ENDPOINT);
    await (await db()).delete(pushSubscriptions).where(eq(pushSubscriptions.userId, b.user.id));
    const response = await renewAs(b.user, { oldEndpoint: ENDPOINT, subscription: subscription(ENDPOINT) });
    expect(response.status).toBe(204);
    const [row] = await (await db()).select().from(pushSubscriptions);
    expect(row).toMatchObject({ userId: a.user.id, endpoint: ENDPOINT, p256dh: keys[a.user.id]!.p256dh, auth: keys[a.user.id]!.auth });
    expect(await (await db()).select().from(auditLog).where(eq(auditLog.action, 'security.push_renewed'))).toEqual([]);
  });

  it('writes nothing without a session, and answers the same 204', async () => {
    await subscribeBoth(ENDPOINT);
    const before = await (await db()).select().from(pushSubscriptions);
    const response = await renewAs(null, { oldEndpoint: ENDPOINT, subscription: subscription('https://push.example.test/send/attacker') });
    expect(response.status).toBe(204);
    expect(await (await db()).select().from(pushSubscriptions)).toEqual(before);
    expect(await (await db()).select().from(auditLog).where(eq(auditLog.action, 'security.push_renewed'))).toEqual([]);
  });

  it('answers the same for an unknown endpoint, writing and auditing nothing', async () => {
    await subscribeBoth(ENDPOINT);
    const response = await renewAs(a.user, {
      oldEndpoint: 'https://push.example.test/send/unknown',
      subscription: subscription('https://push.example.test/send/attacker'),
    });
    expect(response.status).toBe(204);
    expect(await (await db()).select().from(pushSubscriptions).where(like(pushSubscriptions.endpoint, '%attacker%'))).toEqual([]);
    expect(await (await db()).select().from(auditLog).where(eq(auditLog.action, 'security.push_renewed'))).toEqual([]);
  });

  it('checks the Origin and the body, and serves the public VAPID key without a session', async () => {
    await subscribeBoth(ENDPOINT);
    const { renew } = await routes();
    state.current = a.user;
    const body = { oldEndpoint: ENDPOINT, subscription: subscription('https://push.example.test/send/elsewhere') };
    expect((await call(renew.POST as Handler, '/api/push/subscription/renew', { method: 'POST', body, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call(renew.POST as Handler, '/api/push/subscription/renew', { method: 'POST', body: { oldEndpoint: 'http://insecure.example/x', subscription: body.subscription } })).status).toBe(422);
    vi.stubEnv('NODE_ENV', 'production');
    expect((await call(renew.POST as Handler, '/api/push/subscription/renew', { method: 'POST', body: { oldEndpoint: ENDPOINT, subscription: subscription('https://b-controlled.example/x') } })).status).toBe(422);
    expect(await (await db()).select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, ENDPOINT))).toHaveLength(2);
    state.current = null;
    expect(await (await call(renew.GET as Handler, '/api/push/subscription/renew')).json()).toEqual({ enabled: true, publicKey: KEYS.publicKey });
  });
});
