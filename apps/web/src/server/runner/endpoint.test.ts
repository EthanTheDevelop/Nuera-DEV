import { environments } from '@nuera/db/schema';
import { hashToken } from '@nuera/shared/tokens';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWebTestDb, prepareTenancyDatabase, useTestEncryptionKey } from '@/server/tenancy/test/db';
import { startFakeRunner, type FakeRunner } from '@/server/tenancy/test/fake-runner';
import { createTestAccount, createTestEnvironment, resetTenancyCaches, truncateTenancy } from '@/server/tenancy/test/fixtures';

/*
 * Runner endpoint of a server: `env` (default server: RUNNER_URL / RUNNER_TOKEN read at each call),
 * `db` (url + token decrypted from its row), 30 s cache and invalidation, rotation fallback, the
 * default server's fingerprint bootstrap, and the contract version guard.
 */

const config = await import('./config');
const client = await import('./client');
const { db } = await import('@/server/db');

const RUNNER_TOKEN = 'runner-token-for-tests-0123456789abcdef';
let runnerA: FakeRunner;
let runnerB: FakeRunner;

beforeAll(async () => {
  await prepareTenancyDatabase('endpoint');
  useTestEncryptionKey();
  runnerA = await startFakeRunner();
  runnerB = await startFakeRunner();
});

afterAll(async () => {
  await runnerA.close();
  await runnerB.close();
  await closeWebTestDb();
});

beforeEach(async () => {
  vi.stubEnv('RUNNER_URL', runnerA.url);
  vi.stubEnv('RUNNER_TOKEN', RUNNER_TOKEN);
  await truncateTenancy();
  client.invalidateRunnerContract();
  runnerA.requests.length = 0;
  runnerB.requests.length = 0;
});

const tool = { available: true, version: '1.0.0', error: null };
const health = (contractVersion?: number) => ({
  ok: true,
  service: 'runner',
  version: '0.1.0',
  startedAt: new Date().toISOString(),
  uptimeSec: 1,
  backend: 'pty',
  git: tool,
  tmux: { available: false, version: null, error: null },
  claude: tool,
  database: { ok: true, error: null },
  disk: null,
  projectsRoot: '/srv/dev',
  dataDir: '/srv/nuera',
  ...(contractVersion !== undefined ? { contractVersion } : {}),
});

describe('getRunnerEndpoint', () => {
  it("reads RUNNER_URL / RUNNER_TOKEN at each call for the default server ('env')", async () => {
    const owner = await createTestAccount({ role: 'owner' });
    const endpoint = await config.getRunnerEndpoint(owner.environment!.id);
    expect(endpoint).toMatchObject({ name: 'VPS-3', isDefault: true, configSource: 'env', baseUrl: runnerA.url, token: RUNNER_TOKEN, problem: null });
    vi.stubEnv('RUNNER_URL', `${runnerB.url}/`);
    expect((await config.getRunnerEndpoint(owner.environment!.id)).baseUrl).toBe(runnerB.url);
    vi.stubEnv('RUNNER_TOKEN', '');
    expect(await config.getRunnerEndpoint(owner.environment!.id)).toMatchObject({ token: null, problem: "RUNNER_TOKEN n'est pas configuré côté web." });
  });

  it("decrypts the token of a 'db' server and caches the row 30 s until invalidated", async () => {
    const member = await createTestAccount({ environment: { url: runnerB.url, name: 'VPS-4' } });
    const id = member.environment!.id;
    const endpoint = await config.getRunnerEndpoint(id);
    expect(endpoint).toMatchObject({ name: 'VPS-4', isDefault: false, configSource: 'db', baseUrl: runnerB.url, token: member.token, fallbackToken: null, problem: null });

    await db.update(environments).set({ name: 'VPS-5', url: runnerA.url }).where(eq(environments.id, id));
    expect((await config.getRunnerEndpoint(id)).name).toBe('VPS-4');
    config.invalidateRunnerEndpoint(id);
    expect(await config.getRunnerEndpoint(id)).toMatchObject({ name: 'VPS-5', baseUrl: runnerA.url });

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await db.update(environments).set({ name: 'VPS-6' }).where(eq(environments.id, id));
      vi.setSystemTime(Date.now() + 31_000);
      expect((await config.getRunnerEndpoint(id)).name).toBe('VPS-6');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never stores the token in clear and binds the ciphertext to its row', async () => {
    const member = await createTestAccount({ environment: { url: runnerB.url } });
    const [row] = await db.select().from(environments).where(eq(environments.id, member.environment!.id));
    expect(row!.tokenEncrypted).not.toContain(member.token!);
    expect(row!.tokenHash).toBe(hashToken(member.token!));

    // The ciphertext copied onto another server's row does not decrypt there.
    const other = await createTestAccount({ environment: { url: runnerA.url } });
    await db.update(environments).set({ tokenEncrypted: row!.tokenEncrypted }).where(eq(environments.id, other.environment!.id));
    config.invalidateRunnerEndpoint();
    const endpoint = await config.getRunnerEndpoint(other.environment!.id);
    expect(endpoint.token).toBeNull();
    expect(endpoint.problem).toMatch(/^Le jeton du serveur Serveur de test est illisible/);
    await expect(client.getRunnerForEnvironment(other.environment!.id).health()).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE' });
    expect(runnerA.requests).toHaveLength(0);
  });

  it('reports a server without URL or token, and an unknown server', async () => {
    const noUrl = await createTestEnvironment({ spaceId: null, url: null, name: 'VPS-7' });
    expect(await config.getRunnerEndpoint(noUrl.id)).toMatchObject({ baseUrl: null, problem: "L'adresse du serveur VPS-7 n'est pas configurée." });
    const noToken = await createTestEnvironment({ spaceId: null, token: null, name: 'VPS-8' });
    expect(await config.getRunnerEndpoint(noToken.id)).toMatchObject({ token: null, problem: "Le jeton du serveur VPS-8 n'est pas configuré." });
    await expect(config.getRunnerEndpoint('0b9d8c7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e')).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Serveur introuvable.' });
  });

  it('offers the token being rotated in as a fallback', async () => {
    const env = await createTestEnvironment({ spaceId: null, url: runnerB.url, token: 'nrt_current-token-0123456789', nextToken: 'nrt_next-token-0123456789abc' });
    expect(await config.getRunnerEndpoint(env.id)).toMatchObject({ token: 'nrt_current-token-0123456789', fallbackToken: 'nrt_next-token-0123456789abc' });
    runnerB.handle((req, res) =>
      req.headers.authorization === 'Bearer nrt_next-token-0123456789abc'
        ? runnerB.json(res, 200, health(2))
        : runnerB.json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Jeton invalide.' } }),
    );
    await expect(client.getRunnerForEnvironment(env.id).health()).resolves.toMatchObject({ contractVersion: 2 });

    // The runner accepted the rotated token: it replaces the old one (MULTICOMPTE §4).
    await vi.waitFor(async () => {
      const [row] = await db.select({ tokenHash: environments.tokenHash, nextTokenHash: environments.nextTokenHash }).from(environments).where(eq(environments.id, env.id));
      expect(row).toEqual({ tokenHash: hashToken('nrt_next-token-0123456789abc'), nextTokenHash: null });
    });
    expect(await config.getRunnerEndpoint(env.id)).toMatchObject({ token: 'nrt_next-token-0123456789abc', fallbackToken: null });
    runnerB.requests.length = 0;
    await client.getRunnerForEnvironment(env.id).health();
    expect(runnerB.requests.map((r) => r.authorization)).toEqual(['Bearer nrt_next-token-0123456789abc']);
  });
});

describe('getRunnerForEnvironment', () => {
  it('sends each call to the runner of its server, with its token', async () => {
    const owner = await createTestAccount({ role: 'owner' });
    const member = await createTestAccount({ environment: { url: runnerB.url } });
    runnerA.handle((_req, res) => runnerA.json(res, 200, health(2)));
    runnerB.handle((_req, res) => runnerB.json(res, 200, health(2)));
    await client.getRunnerForEnvironment(owner.environment!.id).health();
    await client.getRunnerForEnvironment(member.environment!.id).health();
    expect(runnerA.requests.map((r) => r.authorization)).toEqual([`Bearer ${RUNNER_TOKEN}`]);
    expect(runnerB.requests.map((r) => r.authorization)).toEqual([`Bearer ${member.token}`]);
    expect(client.getRunnerForEnvironment(owner.environment!.id)).toBe(client.getRunnerForEnvironment(owner.environment!.id));
  });
});

describe('requireRunnerContract', () => {
  it('refuses politely when the runner is older than the action needs', async () => {
    const member = await createTestAccount({ environment: { url: runnerB.url, name: 'VPS-4' } });
    runnerB.handle((_req, res) => runnerB.json(res, 200, health()));
    await expect(client.requireRunnerContract(member.environment!.id, 2)).rejects.toMatchObject({
      code: 'UPSTREAM',
      reason: 'RUNNER_OUTDATED',
      message: 'Le serveur VPS-4 doit être mis à jour pour cette action.',
    });
    await expect(client.requireRunnerContract(member.environment!.id, 1)).resolves.toBeUndefined();
    // Cached 60 s: one health call for the three checks.
    expect(runnerB.requests).toHaveLength(1);

    client.invalidateRunnerContract(member.environment!.id);
    runnerB.handle((_req, res) => runnerB.json(res, 200, health(3)));
    await expect(client.requireRunnerContract(member.environment!.id)).resolves.toBeUndefined();
  });
});

describe('ensureDefaultRunnerTokenHash', () => {
  it('records sha256(RUNNER_TOKEN) on the default server only while it is empty', async () => {
    const owner = await createTestAccount({ role: 'owner', environment: { configSource: 'env', isDefault: true, token: null } });
    const read = async () => (await db.select({ hash: environments.tokenHash }).from(environments).where(eq(environments.id, owner.environment!.id)))[0]!.hash;
    expect(await read()).toBeNull();
    (globalThis as { __nueraDefaultTokenHash?: unknown }).__nueraDefaultTokenHash = undefined;
    await config.ensureDefaultRunnerTokenHash();
    expect(await read()).toBe(hashToken(RUNNER_TOKEN));

    // Never overwrites a recorded fingerprint (a changed RUNNER_TOKEN is migrate's job).
    await db.update(environments).set({ tokenHash: hashToken('another-token-0123456789') }).where(eq(environments.id, owner.environment!.id));
    vi.stubEnv('RUNNER_TOKEN', 'yet-another-token-0123456789');
    await config.ensureDefaultRunnerTokenHash();
    expect(await read()).toBe(hashToken('another-token-0123456789'));
    resetTenancyCaches();
  });
});
