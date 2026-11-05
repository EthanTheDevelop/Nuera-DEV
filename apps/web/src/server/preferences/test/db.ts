/**
 * Test-only helpers of the Paramètres lot: one PostgreSQL database per test file
 * (`nuera_settings_<suffix>`) on the local cluster of `pnpm db:local`, created and migrated on demand.
 *
 *   NUERA_TEST_PG_ADMIN_URL   admin URL (default postgres://nuera:nuera@127.0.0.1:54329/postgres)
 */
import { createDb } from '@nuera/db';
import { runMigrations } from '@nuera/db/migrate';
import { user } from '@nuera/db/schema';
import { sql } from 'drizzle-orm';

const ADMIN_URL = process.env.NUERA_TEST_PG_ADMIN_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/postgres';

export const TEST_USER_ID = 'settings-owner';

function databaseUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin<T>(fn: (db: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const db = createDb(ADMIN_URL, { max: 1, applicationName: 'nuera-settings-tests' });
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

export async function prepareTestDatabase(suffix: string): Promise<string> {
  if (!/^[a-z0-9_]{1,30}$/.test(suffix)) throw new Error('suffixe de base invalide');
  const name = `nuera_settings_${suffix}`;
  const url = databaseUrl(name);
  const exists = await admin(async (db) => (await db.execute(sql`select 1 from pg_database where datname = ${name}`)).length > 0);
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

export async function resetTables(): Promise<void> {
  const { db } = await import('@/server/db');
  await db.execute(
    sql.raw('truncate table audit_log, operations, permission_requests, session_events, sessions, worktrees, projects, app_settings, "user" restart identity cascade'),
  );
  await db.insert(user).values({ id: TEST_USER_ID, name: 'Camille Laurent', email: 'owner@example.test', twoFactorEnabled: true });
  const { invalidateAppSettingsCache } = await import('@/server/settings');
  invalidateAppSettingsCache();
}

export async function closeTestDb(): Promise<void> {
  const holder = globalThis as { __nueraWebDb?: { $client?: { end: (options?: { timeout?: number }) => Promise<void> } } };
  await holder.__nueraWebDb?.$client?.end({ timeout: 5 }).catch(() => undefined);
  delete holder.__nueraWebDb;
}
