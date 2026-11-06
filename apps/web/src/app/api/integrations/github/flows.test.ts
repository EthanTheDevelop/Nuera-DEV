import { auditLog, githubSources } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/server/auth/session';
import { startFakeGithub, type FakeGithub } from '@/server/github/test/fake-github';
import { closeWebTestDb, prepareWebTestDatabase, useTestEncryptionKey } from '@/server/tenancy/test/db';
import { createTestAccount, truncateTenancy, type TestAccount } from '@/server/tenancy/test/fixtures';

/*
 * GitHub flows through the real route handlers (MULTICOMPTE §7), for several sources in one space:
 * historical routes kept as supersets (install without `source`, DELETE, check), the manifest form
 * of « Ajouter une source GitHub », the callback (replay, return started by another account of the
 * same browser) and the source limit.
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

const ORIGIN = 'http://localhost:3650';
const USER = { login: 'ethanthedevelop', id: 2002, type: 'User' as const };

let fake: FakeGithub;
let a: TestAccount;
let b: TestAccount;

type Handler = (request: NextRequest, context: { params: Promise<unknown> }) => Promise<Response>;

function request(method: string, url: string, options: { form?: string; cookie?: string } = {}): NextRequest {
  const headers: Record<string, string> = { accept: 'text/html,application/json' };
  if (method !== 'GET') headers.origin = ORIGIN;
  if (options.form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (options.cookie) headers.cookie = options.cookie;
  return new NextRequest(`${ORIGIN}${url}`, { method, headers, ...(options.form !== undefined ? { body: options.form } : {}) });
}

async function call(load: () => Promise<Record<string, unknown>>, method: string, url: string, options: { form?: string; cookie?: string; params?: Record<string, string> } = {}) {
  const handler = (await load())[method] as Handler;
  const response = await handler(request(method, url, options), { params: Promise.resolve(options.params ?? {}) });
  return { status: response.status, text: await response.text(), location: response.headers.get('location'), cookies: response.headers.getSetCookie() };
}

/** `name=value` of the first Set-Cookie (the state nonce of the account). */
const cookiePair = (cookies: string[]) => cookies[0]!.split(';')[0]!;

/** « Ajouter une source GitHub » up to the callback: the state of the form and the cookie of the account. */
async function startForm(): Promise<{ state: string; cookie: string }> {
  const started = await call(() => import('./sources/route'), 'POST', '/api/integrations/github/sources', { form: 'organization=&public=false' });
  expect(started.status).toBe(200);
  const action = /action="([^"]+)"/.exec(started.text)?.[1]?.replaceAll('&amp;', '&');
  const value = action ? new URL(action).searchParams.get('state') : null;
  expect(value).toBeTruthy();
  return { state: value!, cookie: cookiePair(started.cookies) };
}

async function connect(code: string): Promise<string> {
  const { state: value, cookie } = await startForm();
  const back = await call(() => import('./callback/route'), 'GET', `/api/integrations/github/callback?code=${code}&state=${encodeURIComponent(value)}`, { cookie });
  expect(back.status, back.location ?? '').toBe(303);
  const rows = await (await import('@/server/db')).db.select().from(githubSources).where(eq(githubSources.spaceId, state.current === a.user ? a.space.id : b.space.id));
  return rows.at(-1)!.id;
}

beforeAll(async () => {
  useTestEncryptionKey();
  await prepareWebTestDatabase(`${process.env.NUERA_DB_TEST_PREFIX ?? 'nuera_integrations'}_flows`);
  fake = await startFakeGithub();
});

afterAll(async () => {
  await fake?.close();
  await closeWebTestDb();
});

beforeEach(async () => {
  vi.stubEnv('APP_URL', ORIGIN);
  vi.stubEnv('GITHUB_API_URL', fake.url);
  vi.stubEnv('GITHUB_WEB_URL', 'https://github.example.test');
  vi.stubEnv('GITHUB_FALLBACK_TOKEN', '');
  vi.stubEnv('NUERA_RATE_LIMIT_FACTOR', '100');
  await truncateTenancy();
  const { resetIntegrationState } = await import('@/server/integrations/test/db');
  await resetIntegrationState();
  fake.installations.length = 0;
  fake.repos.length = 0;
  fake.tokens.length = 0;
  fake.apps.splice(1);
  fake.appCodes.clear();
  fake.conversionCodes = new Set(['valid-code']);
  fake.appCodes.set('code-5151', { appId: 5151, slug: 'nuera-dev-5151', name: 'Nuera Dev 5151', owner: USER });
  a = await createTestAccount({ role: 'owner', name: 'Ethan Martin', email: 'ethan@example.test' });
  b = await createTestAccount({ role: 'member', name: 'Camille Laurent', email: 'camille@example.test', environment: { configSource: 'db', name: 'VPS-4' } });
  state.current = a.user;
});

describe('GitHub · historical routes with several sources', () => {
  it('install: the only source without `source`, choose_source with several, the named one otherwise', async () => {
    const first = await connect('valid-code');
    const single = await call(() => import('./install/route'), 'GET', '/api/integrations/github/install');
    expect(single.location?.startsWith('https://github.example.test/apps/nuera-dev-test/installations/new?state=')).toBe(true);
    const second = await connect('code-5151');
    expect(second).not.toBe(first);
    const without = await call(() => import('./install/route'), 'GET', '/api/integrations/github/install');
    expect(without.location).toBe(`${ORIGIN}/integrations?github=choose_source`);
    expect(without.cookies).toEqual([]);
    const named = await call(() => import('./install/route'), 'GET', `/api/integrations/github/install?source=${second}`);
    expect(named.location?.startsWith('https://github.example.test/apps/nuera-dev-5151/installations/new?state=')).toBe(true);
    expect(cookiePair(named.cookies)).toMatch(/^nuera_github_state_[0-9a-f]{8}=.+/);
  });

  it('DELETE /github refuses with several sources and deletes nothing; /check covers every source', async () => {
    await connect('valid-code');
    await connect('code-5151');
    const { db } = await import('@/server/db');
    const deleted = await call(() => import('./route'), 'DELETE', '/api/integrations/github');
    expect(deleted.status).toBe(409);
    expect(JSON.parse(deleted.text)).toMatchObject({ error: { code: 'CONFLICT', message: 'Plusieurs sources GitHub sont connectées : précisez celle à déconnecter.' } });
    expect(await db.select().from(githubSources).where(eq(githubSources.spaceId, a.space.id))).toHaveLength(2);
    const checked = await call(() => import('./check/route'), 'POST', '/api/integrations/github/check');
    expect(checked.status).toBe(200);
    const overview = JSON.parse(checked.text) as { sourceCount: number; sources: Array<{ lastCheckedAt: string | null }>; status: string; reason: string | null };
    expect(overview.sourceCount).toBe(2);
    expect(overview.sources.every((item) => item.lastCheckedAt !== null)).toBe(true);
    // Neither app is installed yet: « 2 sources sur 2 à installer ».
    expect(overview).toMatchObject({ status: 'pending', reason: '2 sources sur 2 à installer' });
    const view = await call(() => import('./route'), 'GET', '/api/integrations/github');
    expect(JSON.parse(view.text)).toMatchObject({ sourceCount: 2, canAddSource: true, maxSources: 10 });
  });
});

describe('GitHub · manifest form and callback', () => {
  it('creates a private app by default, then answers a replayed callback « already_connected »', async () => {
    const { state: value, cookie } = await startForm();
    expect(cookie).toMatch(/^nuera_github_state_[0-9a-f]{8}=/);
    const back = await call(() => import('./callback/route'), 'GET', `/api/integrations/github/callback?code=valid-code&state=${encodeURIComponent(value)}`, { cookie });
    expect(back.location?.startsWith('https://github.example.test/apps/nuera-dev-test/installations/new?state=')).toBe(true);
    const { db } = await import('@/server/db');
    const [row] = await db.select().from(githubSources).where(eq(githubSources.spaceId, a.space.id));
    expect(row?.config).toMatchObject({ public: false });
    fake.conversionCodes.add('valid-code');
    const replay = await call(() => import('./callback/route'), 'GET', `/api/integrations/github/callback?code=valid-code&state=${encodeURIComponent(value)}`, { cookie });
    expect(replay.location).toBe(`${ORIGIN}/integrations?github=already_connected`);
    expect(await db.select().from(githubSources)).toHaveLength(1);
  });

  it('reports wrong_account when the flow was started by another account of the same browser, and records nothing', async () => {
    state.current = b.user;
    const { state: value, cookie } = await startForm();
    // The browser now carries B's state cookie, but A is signed in.
    state.current = a.user;
    const { db } = await import('@/server/db');
    const journal = (await db.select().from(auditLog)).length;
    const back = await call(() => import('./callback/route'), 'GET', `/api/integrations/github/callback?code=valid-code&state=${encodeURIComponent(value)}`, { cookie });
    expect(back.location).toBe(`${ORIGIN}/integrations?github=wrong_account`);
    expect(await db.select().from(githubSources)).toHaveLength(0);
    expect((await db.select().from(auditLog)).length).toBe(journal);
    // Without any state cookie of another account: « state_invalid », as before.
    const plain = await call(() => import('./callback/route'), 'GET', `/api/integrations/github/callback?code=valid-code&state=${encodeURIComponent(value)}`);
    expect(plain.location).toBe(`${ORIGIN}/integrations?github=state_invalid`);
  });

  it('sends a space at the limit back to Intégrations (source_limit), from the form and from the callback', async () => {
    const { state: value, cookie } = await startForm();
    const { db } = await import('@/server/db');
    await db.insert(githubSources).values(
      Array.from({ length: 10 }, (_, index) => ({ spaceId: a.space.id, appId: 90_000 + index, label: `source ${index}`, config: {} })),
    );
    const form = await call(() => import('./sources/route'), 'POST', '/api/integrations/github/sources', { form: 'organization=&public=false' });
    expect(form.location).toBe(`${ORIGIN}/integrations?github=source_limit`);
    const back = await call(() => import('./callback/route'), 'GET', `/api/integrations/github/callback?code=valid-code&state=${encodeURIComponent(value)}`, { cookie });
    expect(back.location).toBe(`${ORIGIN}/integrations?github=source_limit`);
    expect(await db.select().from(githubSources).where(eq(githubSources.spaceId, a.space.id))).toHaveLength(10);
  });
});
