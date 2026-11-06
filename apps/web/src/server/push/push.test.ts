import { createDecipheriv, createECDH, createHmac, randomBytes, type ECDH } from 'node:crypto';
import { pushSubscriptions, session } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import * as webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropSuiteDatabase, pgAvailable, prepareSuiteDatabase, resetAccounts, type TwoAccounts } from '@/server/notifications/test/db';

/**
 * Web Push per account (docs/MULTICOMPTE.md §9): mandatory recipients, one subscription per account
 * and device, renewal of the signed-in account's row only, removal at sign-out / access revocation /
 * access expiry / account disabling, no delivery once the registering access is gone, push service
 * hosts only (no redirect followed), and the recipient tag of the service worker's click guard.
 */

const SUITE = 'push';
const available = await pgAvailable('push.test');
const SECRET_ENV = { BETTER_AUTH_SECRET: 'secret-de-test-assez-long-pour-better-auth-0123456789' };

function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

function vapidConfig() {
  const keys = webpush.generateVAPIDKeys();
  return { enabled: true as const, publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:contact@nuera.studio' };
}

/** Fake push service: records each request and answers by endpoint suffix. */
function fakePushService() {
  const seen: Array<{ url: string; headers: Record<string, string>; size: number; body: Buffer; redirect: RequestRedirect | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = Buffer.from((init?.body as Uint8Array | null) ?? new Uint8Array());
    seen.push({ url, headers: init?.headers as Record<string, string>, size: body.byteLength, body, redirect: init?.redirect });
    if (url.endsWith('/gone')) return new Response(null, { status: 410 });
    if (url.endsWith('/broken')) return new Response(null, { status: 500 });
    if (url.endsWith('/redirect')) return new Response(null, { status: 307, headers: { location: 'http://runner-a:4100/v1/health' } });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** What the browser does (RFC 8291, aes128gcm, single record): the decrypted JSON payload. */
function decryptPushBody(body: Buffer, browser: ECDH, authSecret: Buffer): Record<string, unknown> {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const serverPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const ecdhSecret = browser.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), browser.getPublicKey(), serverPublic, Buffer.from([1])]);
  const ikm = hmac(hmac(authSecret, ecdhSecret), keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\u0001')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\u0001')).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString('utf8')) as Record<string, unknown>;
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

  it('refuses non-https endpoints and malformed keys', async () => {
    const { pushSubscriptionInputSchema, pushRenewalInputSchema } = await import('./index');
    expect(pushSubscriptionInputSchema.safeParse({ endpoint: 'http://push.example.test/x', keys: browserKeys() }).success).toBe(false);
    expect(pushSubscriptionInputSchema.safeParse({ endpoint: 'https://push.example.test/x', keys: { p256dh: 'abc', auth: 'def' } }).success).toBe(false);
    expect(pushRenewalInputSchema.safeParse({ oldEndpoint: 'http://push.example.test/x', subscription: { endpoint: 'https://push.example.test/y', keys: browserKeys() } }).success).toBe(false);
  });

  it('accepts only the endpoints of the push services (an arbitrary or internal host is refused)', async () => {
    const { isPushServiceEndpoint, pushEndpointSchema, pushRenewalInputSchema, pushSubscriptionInputSchema } = await import('./index');
    const prod = { NODE_ENV: 'production' };
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://web.push.apple.com/QGx5',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
    ]) {
      expect(isPushServiceEndpoint(endpoint, prod), endpoint).toBe(true);
    }
    for (const endpoint of [
      'https://b-controlled.example/x',
      'https://runner-a:4100/v1/health',
      'https://10.0.0.5/push',
      'https://[::1]/push',
      'https://fcm.googleapis.com:8443/fcm/send/x',
      'https://user:pw@fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilnotify.windows.com/x',
      'http://fcm.googleapis.com/fcm/send/x',
      'https://push.example.test/x',
      'pas une adresse',
    ]) {
      expect(isPushServiceEndpoint(endpoint, prod), endpoint).toBe(false);
    }
    // Reserved `.test` hosts (tests, e2e) outside production; NUERA_PUSH_HOSTS for another service.
    expect(isPushServiceEndpoint('https://push.example.test/x', { NODE_ENV: 'test' })).toBe(true);
    expect(isPushServiceEndpoint('https://push.example.org/x', { ...prod, NUERA_PUSH_HOSTS: 'push.example.org' })).toBe(true);
    expect(isPushServiceEndpoint('https://eu.push.example.org/x', { ...prod, NUERA_PUSH_HOSTS: ' autre.example , *.push.example.org' })).toBe(true);
    expect(isPushServiceEndpoint('https://push.example.org.evil.example/x', { ...prod, NUERA_PUSH_HOSTS: '*.push.example.org' })).toBe(false);

    vi.stubEnv('NODE_ENV', 'production');
    try {
      const refused = pushSubscriptionInputSchema.safeParse({ endpoint: 'https://b-controlled.example/x', keys: browserKeys() });
      expect(refused.success).toBe(false);
      expect(refused.error?.issues[0]?.message).toBe('service de notifications push non reconnu');
      expect(pushSubscriptionInputSchema.safeParse({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: browserKeys() }).success).toBe(true);
      expect(
        pushRenewalInputSchema.safeParse({ oldEndpoint: 'https://fcm.googleapis.com/fcm/send/x', subscription: { endpoint: 'https://b-controlled.example/x', keys: browserKeys() } })
          .success,
      ).toBe(false);
      // An endpoint used as a key only (sign-out, old endpoint) stays any https address.
      expect(pushEndpointSchema.safeParse('https://ancien-service.example/x').success).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('recipient tag', () => {
  it('is opaque, stable per account, different between accounts, and checked in constant time', async () => {
    const { recipientTag, verifyRecipientTag } = await import('./index');
    const tagA = recipientTag('user_a', SECRET_ENV);
    expect(tagA).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(tagA).not.toContain('user_a');
    expect(recipientTag('user_a', SECRET_ENV)).toBe(tagA);
    expect(recipientTag('user_b', SECRET_ENV)).not.toBe(tagA);
    expect(verifyRecipientTag('user_a', tagA, SECRET_ENV)).toBe(true);
    expect(verifyRecipientTag('user_b', tagA, SECRET_ENV)).toBe(false);
    expect(verifyRecipientTag('user_a', tagA.slice(1), SECRET_ENV)).toBe(false);
    expect(verifyRecipientTag('user_a', null, SECRET_ENV)).toBe(false);
    expect(verifyRecipientTag('user_a', 'pas/un+tag', SECRET_ENV)).toBe(false);
    // Another instance secret gives another tag.
    expect(recipientTag('user_a', { BETTER_AUTH_SECRET: 'autre-secret' })).not.toBe(tagA);
    expect(() => recipientTag('user_a', {})).toThrow(/BETTER_AUTH_SECRET manque/);
    expect(verifyRecipientTag('user_a', tagA, {})).toBe(false);
  });
});

describe.skipIf(!available)('subscriptions and sending, per account', () => {
  let accounts: TwoAccounts;

  beforeAll(async () => {
    await prepareSuiteDatabase(SUITE);
  });

  afterAll(async () => {
    await dropSuiteDatabase(SUITE);
  });

  beforeEach(async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', SECRET_ENV.BETTER_AUTH_SECRET);
    accounts = await resetAccounts();
  });

  async function allRows() {
    const { db } = await import('@/server/db');
    return db.select().from(pushSubscriptions);
  }

  /** A web access (Better Auth session row) of `userId`, active now unless told otherwise. */
  async function openAccess(id: string, userId: string, times: { createdAt?: Date; updatedAt?: Date; expiresAt?: Date } = {}) {
    const { db } = await import('@/server/db');
    const now = Date.now();
    await db.insert(session).values({
      id,
      token: `jeton-${id}`,
      userId,
      createdAt: times.createdAt ?? new Date(now - 60_000),
      updatedAt: times.updatedAt ?? new Date(now - 60_000),
      expiresAt: times.expiresAt ?? new Date(now + 30 * 86_400_000),
    });
  }

  it('upserts one subscription per account and endpoint, sends encrypted payloads and prunes 404/410', async () => {
    const { listPushDevices, sendPush, upsertSubscription } = await import('./index');
    const { a } = accounts;
    await openAccess('acces-1', a.userId);
    await openAccess('acces-2', a.userId);
    const endpoints = ['https://push.example.test/ok', 'https://push.example.test/gone', 'https://push.example.test/broken'];
    for (const endpoint of endpoints) {
      await upsertSubscription(a.userId, { endpoint, keys: browserKeys() }, { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', authSessionId: 'acces-1' });
    }
    await upsertSubscription(a.userId, { endpoint: endpoints[0]!, keys: browserKeys(), deviceLabel: 'PC du bureau' }, { authSessionId: 'acces-2' });
    expect(await listPushDevices(a.userId)).toHaveLength(3);

    const { seen, fetchImpl } = fakePushService();
    const result = await sendPush(
      { title: 'Tests e2e du devis attend votre accord', body: 'npm run test -- e2e · Nuera OS · touchez pour répondre', url: '/workspace/1', tag: 'permission:1', kind: 'permission_request' },
      { userIds: [a.userId], config: vapidConfig(), fetchImpl },
    );
    expect(result).toEqual({ sent: 1, pruned: 1, failed: 1, skipped: null });
    for (const request of seen) {
      expect(request.redirect).toBe('manual');
      expect(request.headers.Authorization).toMatch(/^vapid t=/);
      expect(request.headers['Content-Encoding']).toBe('aes128gcm');
      expect(request.headers.Urgency).toBe('high');
      expect(request.size).toBeGreaterThan(50);
    }
    const rows = await allRows();
    expect(rows.map((row) => row.endpoint).sort()).toEqual([endpoints[2], endpoints[0]].sort());
    const ok = rows.find((row) => row.endpoint === endpoints[0]);
    expect(ok?.lastUsedAt).not.toBeNull();
    expect(ok?.deviceLabel).toBe('PC du bureau');
    expect(ok?.authSessionId).toBe('acces-2');
  });

  it('sends only to the named recipients: A never receives B, the same browser keeps one row per account', async () => {
    const { isEndpointSubscribed, listPushDevices, sendPush, upsertSubscription } = await import('./index');
    const { a, b } = accounts;
    const shared = 'https://push.example.test/navigateur-partage';
    const savedA = await upsertSubscription(a.userId, { endpoint: shared, keys: browserKeys() });
    expect(savedA.sharedWithOtherAccount).toBe(false);
    const savedB = await upsertSubscription(b.userId, { endpoint: shared, keys: browserKeys() });
    expect(savedB.sharedWithOtherAccount).toBe(true);
    await upsertSubscription(b.userId, { endpoint: 'https://push.example.test/telephone-b', keys: browserKeys() });
    expect(savedB.id).not.toBe(savedA.id);
    expect(await allRows()).toHaveLength(3);

    // Each account lists only its own devices.
    expect((await listPushDevices(a.userId)).map((device) => device.id)).toEqual([savedA.id]);
    expect(await listPushDevices(b.userId)).toHaveLength(2);
    expect(await isEndpointSubscribed(a.userId, 'https://push.example.test/telephone-b')).toBe(false);
    expect(await isEndpointSubscribed(b.userId, 'https://push.example.test/telephone-b')).toBe(true);

    const { seen, fetchImpl } = fakePushService();
    const result = await sendPush({ title: 'Pour A' }, { userIds: [a.userId], config: vapidConfig(), fetchImpl });
    expect(result.sent).toBe(1);
    expect(seen.map((request) => request.url)).toEqual([shared]);

    // No recipient: nothing is sent to anybody.
    const none = await sendPush({ title: 'Personne' }, { userIds: [], config: vapidConfig(), fetchImpl });
    expect(none).toEqual({ sent: 0, pruned: 0, failed: 0, skipped: 'Aucun destinataire.' });
    expect(seen).toHaveLength(1);
  });

  it('puts the recipient tag of each subscription owner into its (encrypted) payload', async () => {
    const { recipientTag, sendPush, upsertSubscription } = await import('./index');
    const { a, b } = accounts;
    const browsers = [a, b].map((account, index) => {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      return { account, ecdh, auth: randomBytes(16), endpoint: `https://push.example.test/${index === 0 ? 'a' : 'b'}` };
    });
    for (const browser of browsers) {
      await upsertSubscription(browser.account.userId, {
        endpoint: browser.endpoint,
        keys: { p256dh: browser.ecdh.getPublicKey().toString('base64url'), auth: browser.auth.toString('base64url') },
      });
    }
    const { seen, fetchImpl } = fakePushService();
    await sendPush({ title: 'Les deux', url: '/workspace/x', notificationId: 'n1' }, { userIds: [a.userId, b.userId], config: vapidConfig(), fetchImpl });
    expect(seen).toHaveLength(2);
    const [forA, forB] = browsers.map((browser) => decryptPushBody(seen.find((request) => request.url === browser.endpoint)!.body, browser.ecdh, browser.auth));
    expect(forA).toMatchObject({ title: 'Les deux', url: '/workspace/x', notificationId: 'n1', recipient: recipientTag(a.userId) });
    expect(forB!.recipient).toBe(recipientTag(b.userId));
    expect(forA!.recipient).not.toBe(forB!.recipient);
    // The payload never carries the account id or e-mail in clear.
    expect(JSON.stringify(forA)).not.toContain(a.userId);
    expect(JSON.stringify(forA)).not.toContain(a.email);
  });

  it('skips with the reason when disabled, without devices or without the tag secret', async () => {
    const { sendPush, upsertSubscription } = await import('./index');
    const { a } = accounts;
    expect((await sendPush({ title: 'x' }, { userIds: [a.userId], config: { enabled: false, reason: 'désactivé' } })).skipped).toBe('désactivé');
    expect((await sendPush({ title: 'x' }, { userIds: [a.userId], config: vapidConfig() })).skipped).toBe('Aucun appareil abonné.');
    await upsertSubscription(a.userId, { endpoint: 'https://push.example.test/ok', keys: browserKeys() });
    const { seen, fetchImpl } = fakePushService();
    const noSecret = await sendPush({ title: 'x' }, { userIds: [a.userId], config: vapidConfig(), fetchImpl, env: {} });
    expect(noSecret.skipped).toMatch(/BETTER_AUTH_SECRET manque/);
    expect(seen).toHaveLength(0);
  });

  it("renews only the signed-in account's row: another account's row on the same browser is never moved or re-keyed", async () => {
    const { renewSubscription, upsertSubscription } = await import('./index');
    const { a, b } = accounts;
    const old = 'https://push.example.test/ancien';
    const renewed = 'https://push.example.test/nouveau';
    const keysOfA = browserKeys();
    await upsertSubscription(a.userId, { endpoint: old, keys: keysOfA });
    await upsertSubscription(b.userId, { endpoint: old, keys: browserKeys() });
    await upsertSubscription(b.userId, { endpoint: 'https://push.example.test/autre', keys: browserKeys() });
    const keysOfB = browserKeys();

    // B (signed in on the shared browser) renews towards an endpoint and keys it controls: only B's row moves.
    expect(await renewSubscription(b.userId, old, { endpoint: renewed, keys: keysOfB })).toBe(1);
    const rows = await allRows();
    expect(rows.filter((row) => row.endpoint === renewed).map((row) => [row.userId, row.p256dh])).toEqual([[b.userId, keysOfB.p256dh]]);
    expect(rows.filter((row) => row.endpoint === old).map((row) => [row.userId, row.p256dh, row.auth])).toEqual([[a.userId, keysOfA.p256dh, keysOfA.auth]]);
    expect(rows.filter((row) => row.userId === b.userId)).toHaveLength(2);

    // Same endpoint, other keys: B cannot re-key A's row either.
    expect(await renewSubscription(b.userId, old, { endpoint: old, keys: browserKeys() })).toBe(0);
    expect((await allRows()).find((row) => row.userId === a.userId)).toMatchObject({ endpoint: old, p256dh: keysOfA.p256dh, auth: keysOfA.auth });

    // Unknown old endpoint for this account, or no account: nothing written.
    expect(await renewSubscription(a.userId, 'https://push.example.test/inconnu', { endpoint: 'https://push.example.test/vol', keys: browserKeys() })).toBe(0);
    expect(await renewSubscription('', old, { endpoint: 'https://push.example.test/vol', keys: browserKeys() })).toBe(0);
    expect((await allRows()).some((row) => row.endpoint === 'https://push.example.test/vol')).toBe(false);

    // A renews its own row.
    expect(await renewSubscription(a.userId, old, { endpoint: 'https://push.example.test/nouveau-a', keys: keysOfB })).toBe(1);
    expect((await allRows()).find((row) => row.userId === a.userId)?.endpoint).toBe('https://push.example.test/nouveau-a');
  });

  it('renewal onto an endpoint the account already holds merges the rows', async () => {
    const { renewSubscription, upsertSubscription } = await import('./index');
    const { a } = accounts;
    await upsertSubscription(a.userId, { endpoint: 'https://push.example.test/ancien', keys: browserKeys() });
    await upsertSubscription(a.userId, { endpoint: 'https://push.example.test/nouveau', keys: browserKeys() });
    const keys = browserKeys();
    expect(await renewSubscription(a.userId, 'https://push.example.test/ancien', { endpoint: 'https://push.example.test/nouveau', keys })).toBe(1);
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: a.userId, endpoint: 'https://push.example.test/nouveau', p256dh: keys.p256dh });
    // Same endpoint, new keys.
    const again = browserKeys();
    expect(await renewSubscription(a.userId, 'https://push.example.test/nouveau', { endpoint: 'https://push.example.test/nouveau', keys: again })).toBe(1);
    expect((await allRows())[0]?.auth).toBe(again.auth);
  });

  it("deletes per account, per access and for a whole account, never another account's rows", async () => {
    const { deleteSubscription, deleteSubscriptionById, deleteSubscriptionsForSession, deleteSubscriptionsForUser, upsertSubscription } = await import('./index');
    const { a, b } = accounts;
    const shared = 'https://push.example.test/partage';
    const savedA = await upsertSubscription(a.userId, { endpoint: shared, keys: browserKeys() }, { authSessionId: 'acces-a' });
    await upsertSubscription(a.userId, { endpoint: 'https://push.example.test/a2', keys: browserKeys() }, { authSessionId: 'acces-a2' });
    const savedB = await upsertSubscription(b.userId, { endpoint: shared, keys: browserKeys() }, { authSessionId: 'acces-b' });
    await upsertSubscription(b.userId, { endpoint: 'https://push.example.test/b2', keys: browserKeys() }, { authSessionId: 'acces-b' });

    // B cannot remove A's device, by id or by endpoint.
    expect(await deleteSubscriptionById(b.userId, savedA.id)).toBe(false);
    expect(await deleteSubscription(b.userId, 'https://push.example.test/a2')).toBe(false);
    expect(await allRows()).toHaveLength(4);

    // Sign-out of A on the shared browser: only A's row goes.
    expect(await deleteSubscription(a.userId, shared)).toBe(true);
    expect((await allRows()).filter((row) => row.endpoint === shared).map((row) => row.userId)).toEqual([b.userId]);

    // Revoking B's access removes the devices it registered.
    expect(await deleteSubscriptionsForSession('acces-b')).toBe(2);
    expect((await allRows()).map((row) => row.userId)).toEqual([a.userId]);
    expect(await deleteSubscriptionById(b.userId, savedB.id)).toBe(false);

    // Disabling A removes all of A's devices.
    expect(await deleteSubscriptionsForUser(a.userId)).toBe(1);
    expect(await allRows()).toHaveLength(0);
    expect(await deleteSubscriptionsForSession('')).toBe(0);
    expect(await deleteSubscriptionsForUser('')).toBe(0);
  });

  it('never delivers to a subscription whose web access is gone, expired or past the policy, and prunes it', async () => {
    const { sendPush, upsertSubscription } = await import('./index');
    const { db } = await import('@/server/db');
    const { a, b } = accounts;
    const now = Date.now();
    const HOUR = 3_600_000;
    await openAccess('acces-ouvert', a.userId);
    await openAccess('acces-expire', a.userId, { expiresAt: new Date(now - 1_000) });
    await openAccess('acces-inactif', a.userId, { createdAt: new Date(now - 20 * HOUR), updatedAt: new Date(now - 13 * HOUR) });
    await openAccess('acces-trop-long', a.userId, { createdAt: new Date(now - 31 * 24 * HOUR), updatedAt: new Date(now - 60_000) });
    await openAccess('acces-de-b', b.userId);
    const rows: Record<string, string | null> = {
      'https://push.example.test/ouvert': 'acces-ouvert',
      'https://push.example.test/expire': 'acces-expire',
      'https://push.example.test/inactif': 'acces-inactif',
      'https://push.example.test/trop-long': 'acces-trop-long',
      'https://push.example.test/supprime': 'acces-supprime',
      'https://push.example.test/autre-compte': 'acces-de-b',
      'https://push.example.test/ancien': null,
    };
    for (const [endpoint, authSessionId] of Object.entries(rows)) {
      await upsertSubscription(a.userId, { endpoint, keys: browserKeys() }, { authSessionId });
    }
    // Deleting the access row does not cascade (no foreign key): the send refuses the subscription.
    await openAccess('acces-supprime', a.userId);
    await db.delete(session).where(eq(session.id, 'acces-supprime'));
    expect(await allRows()).toHaveLength(7);

    const { seen, fetchImpl } = fakePushService();
    const result = await sendPush({ title: 'Pour A' }, { userIds: [a.userId], config: vapidConfig(), fetchImpl });
    expect(result).toEqual({ sent: 2, pruned: 5, failed: 0, skipped: null });
    expect(seen.map((request) => request.url).sort()).toEqual(['https://push.example.test/ancien', 'https://push.example.test/ouvert']);
    expect((await allRows()).map((row) => row.endpoint).sort()).toEqual(['https://push.example.test/ancien', 'https://push.example.test/ouvert']);

    // Every remaining access closed: nothing sent, the rows go.
    await db.delete(session).where(eq(session.id, 'acces-ouvert'));
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, 'https://push.example.test/ancien'));
    const none = await sendPush({ title: 'Pour A' }, { userIds: [a.userId], config: vapidConfig(), fetchImpl });
    expect(none).toEqual({ sent: 0, pruned: 1, failed: 0, skipped: 'Aucun appareil abonné.' });
    expect(seen).toHaveLength(2);
    expect(await allRows()).toHaveLength(0);
  });

  it('never follows a redirect and never contacts a host that is not a push service', async () => {
    const { sendPush, upsertSubscription } = await import('./index');
    const { db } = await import('@/server/db');
    const { a } = accounts;
    await upsertSubscription(a.userId, { endpoint: 'https://push.example.test/redirect', keys: browserKeys() });
    // Registered before the hosts were enforced (written directly): kept, never contacted.
    const keys = browserKeys();
    await db.insert(pushSubscriptions).values({ userId: a.userId, endpoint: 'https://runner-a:4100/v1/health', p256dh: keys.p256dh, auth: keys.auth });
    const { seen, fetchImpl } = fakePushService();
    const result = await sendPush({ title: 'x' }, { userIds: [a.userId], config: vapidConfig(), fetchImpl });
    expect(result).toEqual({ sent: 0, pruned: 0, failed: 2, skipped: null });
    expect(seen.map((request) => [request.url, request.redirect])).toEqual([['https://push.example.test/redirect', 'manual']]);
    expect(await allRows()).toHaveLength(2);
  });

  it("an access closed by the web-session policy takes its push subscriptions with it (not another access's)", async () => {
    const { upsertSubscription } = await import('./index');
    const { enforceSessionPolicy } = await import('@/server/auth/nuera-plugin');
    const { db } = await import('@/server/db');
    const { a, b } = accounts;
    const HOUR = 3_600_000;
    await openAccess('acces-inactif', a.userId, { createdAt: new Date(Date.now() - 20 * HOUR), updatedAt: new Date(Date.now() - 13 * HOUR) });
    await openAccess('acces-actif', a.userId);
    await openAccess('acces-de-b', b.userId);
    await upsertSubscription(a.userId, { endpoint: 'https://push.example.test/inactif', keys: browserKeys() }, { authSessionId: 'acces-inactif' });
    await upsertSubscription(a.userId, { endpoint: 'https://push.example.test/actif', keys: browserKeys() }, { authSessionId: 'acces-actif' });
    await upsertSubscription(b.userId, { endpoint: 'https://push.example.test/inactif', keys: browserKeys() }, { authSessionId: 'acces-de-b' });

    // The before hook as Better Auth calls it with the cookie of each access.
    const contextFor = (token: string) =>
      ({
        path: '/get-session',
        headers: new Headers({ cookie: 'nuera.session_token=signe' }),
        getSignedCookie: async () => token,
        context: {
          secret: 'secret',
          authCookies: { sessionToken: { name: 'nuera.session_token' } },
          internalAdapter: {
            findSession: async (value: string) => {
              const [row] = await db.select().from(session).where(eq(session.token, value));
              return row ? { session: row, user: { id: row.userId, email: 'x@example.test' } } : null;
            },
            deleteSession: async (value: string) => {
              await db.delete(session).where(eq(session.token, value));
            },
            updateSession: async () => null,
          },
        },
      }) as unknown as Parameters<typeof enforceSessionPolicy>[0];

    await enforceSessionPolicy(contextFor('jeton-acces-actif'));
    expect(await allRows()).toHaveLength(3);
    await enforceSessionPolicy(contextFor('jeton-acces-inactif'));
    expect(await db.select().from(session).where(eq(session.id, 'acces-inactif'))).toHaveLength(0);
    expect((await allRows()).map((row) => row.authSessionId).sort()).toEqual(['acces-actif', 'acces-de-b']);
  });
});
