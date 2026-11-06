import { sql } from 'drizzle-orm';
import { createDb } from '@nuera/db';
import { runMigrations } from '@nuera/db/migrate';
import { seedOwner } from '@nuera/db/test';
import { TOKEN } from './constants';

/**
 * Recreates the runner test database (`nuera_runner_test` on the local PostgreSQL of
 * `pnpm db:local`; override with RUNNER_TEST_DATABASE_URL) and applies the migrations, as `migrate`
 * does in production: RUNNER_TOKEN's hash is recorded on the default server « VPS-3 », then the
 * owner account adopts it (its personal space). Suites start their runners with that token; the
 * other servers are seeded by the suites themselves (helpers.seedServer).
 *
 * PostgreSQL unreachable: database suites are skipped (NUERA_TEST_DB=0), or the run FAILS with
 * NUERA_REQUIRE_PG=1 (before a push).
 */
export default async function setup(): Promise<void> {
  const url = process.env.RUNNER_TEST_DATABASE_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/nuera_runner_test';
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Nom de base de test invalide : ${name}`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const db = createDb(admin.toString(), { max: 1, applicationName: 'nuera-runner-test-setup' });
  const client = (db as unknown as { $client: { end: (o?: { timeout?: number }) => Promise<void> } }).$client;
  try {
    await db.execute(sql.raw(`drop database if exists "${name}" with (force)`));
    await db.execute(sql.raw(`create database "${name}"`));
    await client.end({ timeout: 5 });
    await runMigrations(url, undefined, { runnerToken: TOKEN, log: () => undefined });
    const testDb = createDb(url, { max: 1, applicationName: 'nuera-runner-test-setup' });
    try {
      await seedOwner(testDb, { email: 'proprietaire@example.test', name: 'Ethan Test' });
    } finally {
      await (testDb as unknown as { $client: { end: (o?: { timeout?: number }) => Promise<void> } }).$client.end({ timeout: 5 });
    }
    process.env.NUERA_TEST_DB = '1';
    process.env.RUNNER_TEST_DATABASE_URL = url;
  } catch (error) {
    await client.end({ timeout: 5 }).catch(() => undefined);
    if (process.env.NUERA_REQUIRE_PG === '1') {
      throw new Error(`[runner tests] PostgreSQL indisponible alors que NUERA_REQUIRE_PG=1 : ${(error as Error).message}`, { cause: error });
    }
    process.env.NUERA_TEST_DB = '0';
    console.warn(`[runner tests] PostgreSQL indisponible (${(error as Error).message}) : suites base de données ignorées.`);
  }
}
