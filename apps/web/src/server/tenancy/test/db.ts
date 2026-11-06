/**
 * Test-only: one PostgreSQL database per test file of the tenancy / runner / internal-route suites
 * (`nuera_c2a_<suffix>`) on the local cluster (`pnpm db:local`, port 54329), created and migrated
 * on demand. Never points at nuera_dev: the name is always derived here.
 *
 *   NUERA_TEST_PG_ADMIN_URL   admin URL (default postgres://nuera:nuera@127.0.0.1:54329/postgres)
 *
 * Generic building blocks ({@link prepareWebTestDatabase}, {@link closeWebTestDb}) are shared with
 * the per-lot helpers.
 */
import { randomBytes } from 'node:crypto';
import { createDb } from '@nuera/db';
import { runMigrations } from '@nuera/db/migrate';
import { sql } from 'drizzle-orm';

const ADMIN_URL = process.env.NUERA_TEST_PG_ADMIN_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/postgres';

function databaseUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin<T>(fn: (db: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const db = createDb(ADMIN_URL, { max: 1, applicationName: 'nuera-web-tests' });
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

/**
 * Creates (if needed) and migrates database `name`, then points DATABASE_URL and the app db at it.
 * A database whose migration history no longer matches (regenerated migration) is recreated.
 */
export async function prepareWebTestDatabase(name: string): Promise<string> {
  if (!/^nuera_[a-z0-9_]{1,50}$/.test(name)) throw new Error('nom de base de test invalide');
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

/** Drops a test database created by {@link prepareWebTestDatabase} (end of a suite). */
export async function dropWebTestDatabase(name: string): Promise<void> {
  if (!/^nuera_[a-z0-9_]{1,50}$/.test(name)) throw new Error('nom de base de test invalide');
  await admin(async (db) => {
    await db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`);
    await db.execute(sql.raw(`drop database if exists "${name}"`));
  });
}

/** `nuera_c2a_<suffix>` for the suites of this lot. */
export function prepareTenancyDatabase(suffix: string): Promise<string> {
  if (!/^[a-z0-9_]{1,30}$/.test(suffix)) throw new Error('suffixe de base invalide');
  return prepareWebTestDatabase(`nuera_c2a_${suffix}`);
}

export async function closeWebTestDb(): Promise<void> {
  const holder = globalThis as { __nueraWebDb?: { $client?: { end: (options?: { timeout?: number }) => Promise<void> } } };
  await holder.__nueraWebDb?.$client?.end({ timeout: 5 }).catch(() => undefined);
  delete holder.__nueraWebDb;
}

/** Random 32-byte key for AES-256-GCM (crypto.ts reads it at call time). */
export function useTestEncryptionKey(): void {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  delete process.env.APP_ENCRYPTION_KEY_ID;
  delete process.env.APP_ENCRYPTION_PREVIOUS_KEYS;
}
