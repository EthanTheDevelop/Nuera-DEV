import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, type Database } from '@nuera/db';
import { MIGRATIONS_FOLDER, runMigrations } from '@nuera/db/migrate';
import { createRunnerLoginRole, dropRole, seedEnvironment } from '@nuera/db/test';
import { hashToken } from '@nuera/shared/tokens';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnvironmentContext } from '../src/environment';
import { dbReady, dbUrl, silentLogger, testConfig } from './helpers';

/**
 * A restricted runner of a newer version against a database not yet at migration 0005 (an
 * additional server updated before the instance): `nuera_runner_try_lease()` does not exist there,
 * the runner falls back to the direct `pg_try_advisory_lock` (still open to PUBLIC before 0005),
 * with the same key. Own database migrated up to 0004 only.
 */
type SqlClient = Parameters<typeof createRunnerLoginRole>[0] & { end: (o?: { timeout?: number }) => Promise<void> };
const clientOf = (db: Database) => (db as unknown as { $client: SqlClient }).$client;

describe.skipIf(!dbReady)('lease of a restricted runner against a database at 0004', () => {
  const baseName = new URL(dbUrl).pathname.slice(1);
  const database = `${baseName}_0004`.slice(0, 63);
  const role = `${baseName}_0004_r`.slice(0, 63);
  const password = randomBytes(16).toString('hex');
  const token = `test-runner-token-0004-${Date.now().toString(36)}`;
  const adminUrl = new URL(dbUrl);
  adminUrl.pathname = '/postgres';
  const url = new URL(dbUrl);
  url.pathname = `/${database}`;
  const restrictedUrl = new URL(url.toString());
  restrictedUrl.username = role;
  restrictedUrl.password = password;

  let admin: SqlClient;
  let owner: SqlClient;
  let restrictedDb: Database;
  let folder: string;
  let environmentId: string;
  const contexts: EnvironmentContext[] = [];

  const context = () => {
    const ctx = new EnvironmentContext({
      db: restrictedDb,
      config: testConfig({ projects: folder, data: folder, remotes: folder }, { token, databaseUrl: restrictedUrl.toString() }),
      logger: silentLogger,
    });
    contexts.push(ctx);
    return ctx;
  };

  beforeAll(async () => {
    if (!/^[a-z0-9_]+$/.test(database) || !/^[a-z0-9_]+$/.test(role)) throw new Error(`Nom de base de test invalide : ${database}`);
    folder = mkdtempSync(path.join(tmpdir(), 'nuera-lease-0004-'));
    mkdirSync(path.join(folder, 'meta'));
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    const entries = journal.entries.slice(0, journal.entries.findIndex((entry) => entry.tag === '0004_runner_roles') + 1);
    for (const entry of entries) copyFileSync(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
    writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));

    admin = clientOf(createDb(adminUrl.toString(), { max: 1, applicationName: 'nuera-runner-test-0004-admin' }));
    await admin.unsafe(`drop database if exists "${database}" with (force)`);
    await admin.unsafe(`create database "${database}"`);
    await runMigrations(url.toString(), folder, { log: () => undefined });
    owner = clientOf(createDb(url.toString(), { max: 1, applicationName: 'nuera-runner-test-0004-owner' }));
    await createRunnerLoginRole(owner, role, password);
    const ownerDb = createDb(url.toString(), { max: 1, applicationName: 'nuera-runner-test-0004' });
    try {
      environmentId = await seedEnvironment(ownerDb, { spaceId: null, name: 'Serveur en 0004', tokenHash: hashToken(token), dbRole: role });
    } finally {
      await clientOf(ownerDb).end({ timeout: 5 });
    }
    restrictedDb = createDb(restrictedUrl.toString(), { max: 2, applicationName: 'nuera-runner-test-0004-restreint' });
  }, 300_000);

  afterAll(async () => {
    for (const ctx of contexts) await ctx.releaseLease().catch(() => undefined);
    if (restrictedDb) await clientOf(restrictedDb).end({ timeout: 5 }).catch(() => undefined);
    await owner?.end({ timeout: 5 }).catch(() => undefined);
    if (admin) {
      await admin.unsafe(`drop database if exists "${database}" with (force)`).catch(() => undefined);
      await dropRole(admin, role).catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    }
    if (folder) rmSync(folder, { recursive: true, force: true });
  }, 120_000);

  it('falls back to the direct advisory lock, under the same key, and releases it', async () => {
    expect(await owner`select to_regprocedure('public.nuera_runner_try_lease()') as fn`).toEqual([{ fn: null }]);
    const first = context();
    expect((await first.resolve())?.id).toBe(environmentId);
    expect((await first.databaseAccess()).restricted).toBe(true);
    expect(await first.tryAcquireLease()).toBe(true);
    expect(first.holdsLease).toBe(true);

    // Same key as a runner using the full DSN, or as nuera_runner_try_lease() after 0005.
    const key = `nuera:environment:${environmentId}`;
    expect(await owner`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as locked`).toEqual([{ locked: false }]);
    const second = context();
    await second.resolve();
    expect(await second.tryAcquireLease()).toBe(false);

    await first.releaseLease();
    expect(first.holdsLease).toBe(false);
    expect(await second.tryAcquireLease()).toBe(true);
    await second.releaseLease();
    expect(await owner`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as locked`).toEqual([{ locked: true }]);
    expect(await owner`select pg_advisory_unlock(hashtextextended(${key}, 0)) as released`).toEqual([{ released: true }]);
  });
});
