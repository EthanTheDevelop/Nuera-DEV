/**
 * TEST-ONLY — database of a stack on the local PostgreSQL (`pnpm db:local`, port 54329).
 * Never touches nuera_dev: names are validated by config.assertDatabaseName.
 */
import { createDb, type Database } from '@nuera/db';
import { runMigrations } from '@nuera/db/migrate';
import { sql } from 'drizzle-orm';
import { assertDatabaseName } from './config';

async function withAdmin<T>(adminUrl: string, fn: (db: Database) => Promise<T>): Promise<T> {
  const db = createDb(adminUrl, { max: 1, applicationName: 'nuera-harness-admin', connectTimeout: 30 });
  try {
    return await fn(db);
  } finally {
    await db.$client.end({ timeout: 5 }).catch(() => undefined);
  }
}

export async function postgresReachable(adminUrl: string): Promise<boolean> {
  try {
    await withAdmin(adminUrl, (db) => db.execute(sql`select 1`));
    return true;
  } catch {
    return false;
  }
}

export async function databaseExists(adminUrl: string, name: string): Promise<boolean> {
  assertDatabaseName(name);
  return withAdmin(adminUrl, async (db) => (await db.execute(sql`select 1 as found from pg_database where datname = ${name}`)).length > 0);
}

/** Creates the database (drops it first with `reset`). Returns true when it was created. */
export async function ensureDatabase(adminUrl: string, name: string, options: { reset?: boolean } = {}): Promise<boolean> {
  assertDatabaseName(name);
  return withAdmin(adminUrl, async (db) => {
    if (options.reset) {
      await db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`);
      await db.execute(sql.raw(`drop database if exists "${name}"`));
    }
    const exists = (await db.execute(sql`select 1 as found from pg_database where datname = ${name}`)).length > 0;
    if (!exists) await db.execute(sql.raw(`create database "${name}"`));
    return !exists;
  });
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  assertDatabaseName(name);
  await withAdmin(adminUrl, async (db) => {
    await db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`);
    await db.execute(sql.raw(`drop database if exists "${name}"`));
  });
}

export async function migrate(url: string): Promise<void> {
  await runMigrations(url);
}

/** Short-lived connection to the stack database. */
export async function withStackDb<T>(url: string, fn: (db: Database) => Promise<T>): Promise<T> {
  const db = createDb(url, { max: 2, applicationName: 'nuera-harness', connectTimeout: 60 });
  try {
    return await fn(db);
  } finally {
    await db.$client.end({ timeout: 5 }).catch(() => undefined);
  }
}
