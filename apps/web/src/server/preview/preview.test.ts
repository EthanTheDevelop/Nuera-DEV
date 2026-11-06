import { commandRuns, session as authSession, user as users } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeWebTestDb, prepareTenancyDatabase, useTestEncryptionKey } from '@/server/tenancy/test/db';
import { startFakeRunner, type FakeRunner } from '@/server/tenancy/test/fake-runner';
import { createTestAccount, createTestResources, truncateTenancy, type TestAccount, type TestResources } from '@/server/tenancy/test/fixtures';

/*
 * « Aperçu »: tokens (signature, expiry, single use, purpose), the access re-check behind every
 * preview request (account, web access, space of the run, dev run), the handoff refused for a run
 * of another space without any runner call, the entry (cookie) and the relay, host-bound.
 */

process.env.BETTER_AUTH_SECRET = 'tests-only-better-auth-secret-0123456789abcdef';
process.env.APP_URL = 'https://dev.example.test';
process.env.PREVIEW_HOST = 'apercu.example.test';

const tokens = await import('./tokens');
const access = await import('./access');
const handoff = await import('./handoff');
const serve = await import('./serve');
const { db } = await import('@/server/db');

const GRANT = { userId: 'user_a', authSessionId: 'sess_a', runId: '11111111-1111-4111-8111-111111111111' };

describe('preview tokens', () => {
  beforeEach(() => tokens.resetPreviewNonces());

  it('a handoff token is valid once, for 60 s, and only untouched', () => {
    const now = Date.now();
    const { token } = tokens.issueHandoffToken({ ...GRANT, path: '/devis?id=3' }, now);
    expect(tokens.consumeHandoffToken(token, now + 1_000)).toMatchObject({ ...GRANT, path: '/devis?id=3' });
    expect(tokens.consumeHandoffToken(token, now + 2_000)).toBeNull();
    const late = tokens.issueHandoffToken({ ...GRANT, path: '/' }, now).token;
    expect(tokens.consumeHandoffToken(late, now + 61_000)).toBeNull();
    const fresh = tokens.issueHandoffToken({ ...GRANT, path: '/' }, now).token;
    const [payload, signature] = fresh.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), r: 'autre' })).toString('base64url');
    expect(tokens.consumeHandoffToken(`${forged}.${signature}`, now)).toBeNull();
    expect(tokens.consumeHandoffToken(`${payload}.${signature.slice(0, -2)}xx`, now)).toBeNull();
    expect(tokens.consumeHandoffToken(fresh, now)).not.toBeNull();
  });

  it('a cookie is valid 12 h and never interchangeable with a handoff token', () => {
    const now = Date.now();
    const cookie = tokens.issuePreviewCookie(GRANT, now);
    expect(tokens.readPreviewCookie(cookie.value, now + 3_600_000)).toMatchObject(GRANT);
    expect(tokens.readPreviewCookie(cookie.value, now + 12 * 3_600_000 + 1)).toBeNull();
    expect(tokens.consumeHandoffToken(cookie.value, now)).toBeNull();
    const handoffToken = tokens.issueHandoffToken({ ...GRANT, path: '/' }, now).token;
    expect(tokens.readPreviewCookie(handoffToken, now)).toBeNull();
    expect(tokens.readPreviewCookie(undefined, now)).toBeNull();
    expect(tokens.readPreviewCookie('garbage', now)).toBeNull();
  });

  it('another BETTER_AUTH_SECRET invalidates every token', () => {
    const cookie = tokens.issuePreviewCookie(GRANT).value;
    const previous = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = 'another-tests-only-secret-0123456789abcdefgh';
    try {
      expect(tokens.readPreviewCookie(cookie)).toBeNull();
    } finally {
      process.env.BETTER_AUTH_SECRET = previous;
    }
  });

  it('the cookie header is host-only, HttpOnly, SameSite as configured', () => {
    const header = tokens.previewCookieHeader('nuera_apercu', 'v', { maxAgeSeconds: 43_200, secure: true, sameSite: 'lax' });
    expect(header).toBe('nuera_apercu=v; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax; Secure');
    expect(header).not.toMatch(/domain/i);
  });
});

describe.skipIf(process.env.NUERA_TEST_DB === '0')('preview access, handoff, entry and relay', () => {
  let runnerA: FakeRunner;
  let runnerB: FakeRunner;
  let a: TestAccount;
  let b: TestAccount;
  let resA: TestResources;
  let devRunA: string;

  const grantA = () => ({ userId: a.user.id, authSessionId: a.user.authSessionId, runId: devRunA });

  beforeAll(async () => {
    await prepareTenancyDatabase('apercu');
    useTestEncryptionKey();
    runnerA = await startFakeRunner();
    runnerB = await startFakeRunner();
  });

  afterAll(async () => {
    await runnerA?.close();
    await runnerB?.close();
    await closeWebTestDb();
  });

  beforeEach(async () => {
    process.env.PREVIEW_HOST = 'apercu.example.test';
    await truncateTenancy();
    access.invalidatePreviewAccess();
    tokens.resetPreviewNonces();
    a = await createTestAccount({ role: 'owner', environment: { configSource: 'db', isDefault: false, url: runnerA.url, name: 'VPS-3' } });
    b = await createTestAccount({ role: 'member', environment: { configSource: 'db', url: runnerB.url, name: 'VPS-4' } });
    resA = await createTestResources(a, 'apercu-a');
    await createTestResources(b, 'apercu-b');
    const [run] = await db
      .insert(commandRuns)
      .values({ projectId: resA.projectId, environmentId: a.environment!.id, worktreeId: resA.worktreeId, kind: 'dev', command: 'npm run dev', status: 'running', port: 5173 })
      .returning({ id: commandRuns.id });
    devRunA = run!.id;
    const expiresAt = new Date(Date.now() + 86_400_000);
    for (const account of [a, b]) {
      await db.insert(authSession).values({ id: account.user.authSessionId, token: `token-${account.user.id}`, userId: account.user.id, expiresAt });
    }
    runnerA.requests.length = 0;
    runnerB.requests.length = 0;
  });

  const denial = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(access.PreviewDenied);
    return (error as InstanceType<typeof access.PreviewDenied>).reason;
  };

  it('grants the owner of the run, refuses another space, a disabled account, a closed access and a non-dev run', async () => {
    await expect(access.resolvePreviewAccess(grantA())).resolves.toMatchObject({ runId: devRunA, environmentName: 'VPS-3' });
    expect(await denial(access.resolvePreviewAccess({ userId: b.user.id, authSessionId: b.user.authSessionId, runId: devRunA }))).toBe('RUN');
    expect(await denial(access.resolvePreviewAccess({ ...grantA(), runId: resA.runId }))).toBe('NOT_DEV');
    expect(await denial(access.resolvePreviewAccess({ ...grantA(), authSessionId: 'autre-acces' }))).toBe('ACCESS');

    await db.delete(authSession).where(eq(authSession.id, a.user.authSessionId));
    expect(await denial(access.resolvePreviewAccess(grantA(), { fresh: true }))).toBe('ACCESS');

    await db.insert(authSession).values({ id: a.user.authSessionId, token: 'token-a-2', userId: a.user.id, expiresAt: new Date(Date.now() + 86_400_000) });
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, a.user.id));
    expect(await denial(access.resolvePreviewAccess(grantA(), { fresh: true }))).toBe('ACCOUNT');
    expect(runnerA.requests).toHaveLength(0);
    expect(runnerB.requests).toHaveLength(0);
  });

  it('hands off only for a live dev server of the space; another space gets the unknown-run 404 without any runner call', async () => {
    await expect(handoff.createPreviewHandoff(b.ctx, { runId: devRunA })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Lancement introuvable.' });
    expect(runnerA.requests).toHaveLength(0);
    expect(runnerB.requests).toHaveLength(0);

    runnerA.handle((_req, res) =>
      runnerA.json(res, 200, {
        id: devRunA, projectId: resA.projectId, worktreeId: resA.worktreeId, kind: 'dev', command: 'npm run dev', status: 'running',
        exitCode: null, pid: 42, port: 5173, summary: null, tests: null, startedAt: new Date().toISOString(), finishedAt: null, live: true,
      }),
    );
    const result = await handoff.createPreviewHandoff(a.ctx, { runId: devRunA, path: '/devis' });
    expect(result.url).toMatch(/^https:\/\/apercu\.example\.test\/__nuera\/entree\?jeton=/);
    expect(runnerA.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`GET /v1/runs/${devRunA}`]);

    await expect(handoff.createPreviewHandoff(a.ctx, { runId: resA.runId })).rejects.toMatchObject({ code: 'VALIDATION' });
    process.env.PREVIEW_HOST = '';
    await expect(handoff.createPreviewHandoff(a.ctx, { runId: devRunA })).rejects.toMatchObject({ code: 'CONFLICT', reason: 'PREVIEW_DISABLED' });
  });

  it('the entry sets the host-only cookie once; never on the application host', async () => {
    const { token } = tokens.issueHandoffToken({ ...grantA(), path: '/devis' });
    const entry = (host: string) =>
      new NextRequest(`https://${host}/api/apercu/entree?jeton=${encodeURIComponent(token)}`, { headers: { host } });
    expect((await serve.servePreviewEntry(entry('dev.example.test'))).status).toBe(404);
    const response = await serve.servePreviewEntry(entry('apercu.example.test'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/devis');
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^nuera_apercu=[^;]+; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax; Secure$/);
    expect((await serve.servePreviewEntry(entry('apercu.example.test'))).status).toBe(401);
  });

  it("relays with the cookie to the run's server, strips Nuera cookies, adds the position script; refuses without access", async () => {
    runnerA.handle((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-nuera-preview': 'upstream', 'set-cookie': 'theme=1; Path=/' });
      res.end('<!doctype html><html><head><title>Devis</title></head><body>é</body></html>');
    });
    const cookie = tokens.issuePreviewCookie(grantA()).value;
    const request = (headers: Record<string, string>, host = 'apercu.example.test') =>
      new NextRequest(`https://${host}/api/apercu/proxy`, { headers: { host, 'x-nuera-apercu-path': '/src/main.ts?x=1', ...headers } });

    const ok = await serve.servePreviewRequest(request({ cookie: `nuera_apercu=${cookie}; theme=sombre; __Secure-nuera.session_token=s` }));
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toMatch(/^<!doctype html><html><head><script data-nuera-apercu>.*"https:\/\/dev\.example\.test".*<\/script><title>Devis<\/title>/);
    expect(html).toContain('<body>é</body>');
    expect(ok.headers.getSetCookie()).toEqual(['theme=1; Path=/']);
    expect(ok.headers.get('x-nuera-preview')).toBeNull();
    const [relayed] = runnerA.requests;
    expect(relayed).toMatchObject({ method: 'GET', path: `/v1/runs/${devRunA}/preview/src/main.ts?x=1` });
    expect(relayed!.authorization).toMatch(/^Bearer nrt_/);

    expect((await serve.servePreviewRequest(request({}))).status).toBe(401);
    const foreign = tokens.issuePreviewCookie({ userId: b.user.id, authSessionId: b.user.authSessionId, runId: devRunA }).value;
    expect((await serve.servePreviewRequest(request({ cookie: `nuera_apercu=${foreign}` }))).status).toBe(403);
    expect((await serve.servePreviewRequest(request({ cookie: `nuera_apercu=${cookie}` }, 'dev.example.test'))).status).toBe(404);
    expect(runnerA.requests).toHaveLength(1);
    expect(runnerB.requests).toHaveLength(0);
  });

  it('a runner error becomes a short page in the frame', async () => {
    runnerA.handle((_req, res) => runnerA.json(res, 409, { error: { code: 'CONFLICT', message: 'Le serveur de développement est arrêté.', reason: 'PREVIEW_NOT_RUNNING' } }));
    const cookie = tokens.issuePreviewCookie(grantA()).value;
    const response = await serve.servePreviewRequest(
      new NextRequest('https://apercu.example.test/api/apercu/proxy', { headers: { host: 'apercu.example.test', cookie: `nuera_apercu=${cookie}`, 'x-nuera-apercu-path': '/' } }),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('Le serveur de développement est arrêté.');
  });
});
