import { createECDH, randomBytes } from 'node:crypto';
import { pushSubscriptions } from '@nuera/db/schema';
import * as webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDatabase, resetTables, TEST_USER_ID } from '@/server/integrations/test/db';

beforeAll(async () => {
  await prepareTestDatabase('push');
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTables();
});

function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

function vapidConfig() {
  const keys = webpush.generateVAPIDKeys();
  return { enabled: true as const, publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:contact@nuera.studio' };
}

describe('Web Push configuration', () => {
  it('is disabled with an explicit reason when the VAPID keys are missing or invalid', async () => {
    const { getPushConfig } = await import('./index');
    const missing = getPushConfig({});
    expect(missing.enabled).toBe(false);
    expect(!missing.enabled && missing.reason).toContain('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT manquent');
    const keys = webpush.generateVAPIDKeys();
    expect(getPushConfig({ VAPID_PUBLIC_KEY: 'abc', VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:a@b.c' }).enabled).toBe(false);
    expect(getPushConfig({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'nope' }).enabled).toBe(false);
    expect(getPushConfig({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:a@b.c' }).enabled).toBe(true);
  });

  it('labels devices from the user agent', async () => {
    const { deviceLabelFromUserAgent } = await import('./index');
    expect(deviceLabelFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toMatch(/Safari · iPhone/);
    expect(deviceLabelFromUserAgent(null)).toBeNull();
  });
});

describe('subscriptions and sending', () => {
  it('upserts one subscription per endpoint, sends encrypted payloads and prunes 404/410', async () => {
    const { db } = await import('@/server/db');
    const { listPushDevices, savePushSubscription, sendPush } = await import('./index');
    const endpoints = ['https://push.example.test/ok', 'https://push.example.test/gone', 'https://push.example.test/broken'];
    for (const endpoint of endpoints) {
      await savePushSubscription({ userId: TEST_USER_ID, subscription: { endpoint, keys: browserKeys() }, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0' });
    }
    await savePushSubscription({ userId: TEST_USER_ID, subscription: { endpoint: endpoints[0]!, keys: browserKeys(), deviceLabel: 'PC du bureau' } });
    expect(await listPushDevices(TEST_USER_ID)).toHaveLength(3);

    const seen: Array<{ url: string; headers: Record<string, string>; size: number }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string>;
      seen.push({ url, headers, size: (init?.body as Uint8Array | null)?.byteLength ?? 0 });
      if (url.endsWith('/gone')) return new Response(null, { status: 410 });
      if (url.endsWith('/broken')) return new Response(null, { status: 500 });
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    const result = await sendPush(
      { title: 'Tests e2e du devis attend votre accord', body: 'npm run test -- e2e · Nuera OS · touchez pour répondre', url: '/sessions/1', tag: 'permission:1', kind: 'permission_request' },
      { config: vapidConfig(), fetchImpl },
    );
    expect(result).toEqual({ sent: 1, pruned: 1, failed: 1, skipped: null });
    for (const request of seen) {
      expect(request.headers.Authorization).toMatch(/^vapid t=/);
      expect(request.headers['Content-Encoding']).toBe('aes128gcm');
      expect(request.headers.Urgency).toBe('high');
      expect(request.size).toBeGreaterThan(50);
    }
    const rows = await db.select().from(pushSubscriptions);
    expect(rows.map((row) => row.endpoint).sort()).toEqual([endpoints[2], endpoints[0]].sort());
    expect(rows.find((row) => row.endpoint === endpoints[0])?.lastUsedAt).not.toBeNull();
    expect(rows.find((row) => row.endpoint === endpoints[0])?.deviceLabel).toBe('PC du bureau');
  });

  it('skips with the reason when disabled or without devices', async () => {
    const { sendPush } = await import('./index');
    expect((await sendPush({ title: 'x' }, { config: { enabled: false, reason: 'désactivé' } })).skipped).toBe('désactivé');
    expect((await sendPush({ title: 'x' }, { config: vapidConfig() })).skipped).toBe('Aucun appareil abonné.');
  });

  it('refuses non-https endpoints and malformed keys', async () => {
    const { pushSubscriptionInputSchema } = await import('./index');
    expect(pushSubscriptionInputSchema.safeParse({ endpoint: 'http://push.example.test/x', keys: browserKeys() }).success).toBe(false);
    expect(pushSubscriptionInputSchema.safeParse({ endpoint: 'https://push.example.test/x', keys: { p256dh: 'abc', auth: 'def' } }).success).toBe(false);
  });
});
