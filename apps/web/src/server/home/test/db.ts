/**
 * Test-only: one PostgreSQL database per test file of the Accueil / search lots (`nuera_home_<suffix>`)
 * on the local cluster (`pnpm db:local`), created and migrated on demand, emptied between tests.
 *
 *   NUERA_TEST_PG_ADMIN_URL   admin URL (default postgres://nuera:nuera@127.0.0.1:54329/postgres)
 */
import { createDb } from '@nuera/db';
import { runMigrations } from '@nuera/db/migrate';
import { sql } from 'drizzle-orm';
import type { RequestContext } from '@/server/tenancy/context';
import { legacyOwnerContext, seedLegacyOwner, TEST_ENVIRONMENT_ID, TEST_SPACE_ID, type TestAccount } from '@/server/tenancy/test/fixtures';

const ADMIN_URL = process.env.NUERA_TEST_PG_ADMIN_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/postgres';

export const TEST_USER_ID = 'test-owner';

/** Space and default server (« VPS-3 », RUNNER_URL / RUNNER_TOKEN) of the owner seeded by the reset below. */
export { TEST_ENVIRONMENT_ID, TEST_SPACE_ID };

function databaseUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin<T>(fn: (db: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const db = createDb(ADMIN_URL, { max: 1, applicationName: 'nuera-home-tests' });
  try {
    return await fn(db);
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

async function recreate(name: string): Promise<void> {
  await admin(async (db) => {
    await db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`);
    await db.execute(sql.raw(`drop database if exists "${name}"`));
    await db.execute(sql.raw(`create database "${name}"`));
  });
}

export async function prepareHomeTestDatabase(suffix: string): Promise<string> {
  if (!/^[a-z0-9_]{1,30}$/.test(suffix)) throw new Error('suffixe de base invalide');
  const name = `nuera_home_${suffix}`;
  const url = databaseUrl(name);
  const exists = await admin(async (db) => (await db.execute(sql`select 1 as found from pg_database where datname = ${name}`)).length > 0);
  if (!exists) await recreate(name);
  try {
    await runMigrations(url);
  } catch {
    await recreate(name);
    await runMigrations(url);
  }
  process.env.DATABASE_URL = url;
  delete (globalThis as { __nueraWebDb?: unknown }).__nueraWebDb;
  return url;
}

/** Request context of the seeded owner (space TEST_SPACE_ID, server TEST_ENVIRONMENT_ID). */
export function testContext(): RequestContext {
  return legacyOwnerContext({ id: TEST_USER_ID, name: 'Camille Laurent', email: 'owner@example.test' });
}

/**
 * Empties the tables and seeds the owner again with its personal space and the default server
 * (fixed ids TEST_SPACE_ID / TEST_ENVIRONMENT_ID): set them on every inserted project
 * (`spaceId`, `environmentId`) and `environmentId` on worktrees, sessions, runs and operations.
 */
export async function resetHomeTables(): Promise<TestAccount> {
  const { db } = await import('@/server/db');
  await db.execute(
    sql.raw(
      'truncate table operations, pull_requests, permission_requests, session_events, sessions, worktrees, projects, "user" restart identity cascade',
    ),
  );
  return seedLegacyOwner({ id: TEST_USER_ID, name: 'Camille Laurent', email: 'owner@example.test' });
}

export async function closeHomeTestDb(): Promise<void> {
  const holder = globalThis as { __nueraWebDb?: { $client?: { end: (options?: { timeout?: number }) => Promise<void> } } };
  await holder.__nueraWebDb?.$client?.end({ timeout: 5 }).catch(() => undefined);
  delete holder.__nueraWebDb;
}
