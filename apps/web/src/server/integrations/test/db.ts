/**
 * Test-only helpers: one PostgreSQL database per test file (`nuera_integrations_<suffix>`) on the
 * local cluster started by `pnpm db:local`, created and migrated on demand, wiped between tests.
 *
 *   NUERA_TEST_PG_ADMIN_URL   admin URL (default postgres://nuera:nuera@127.0.0.1:54329/postgres)
 *
 * Never points at nuera_dev: the database name is always derived here.
 */
import { randomBytes } from 'node:crypto';
import { createDb } from '@nuera/db';
import { runMigrations } from '@nuera/db/migrate';
import { user } from '@nuera/db/schema';
import { sql } from 'drizzle-orm';

const ADMIN_URL = process.env.NUERA_TEST_PG_ADMIN_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/postgres';

export const TEST_USER_ID = 'test-owner';

function databaseUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin<T>(fn: (db: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const db = createDb(ADMIN_URL, { max: 1, applicationName: 'nuera-integrations-tests' });
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

/** Creates/migrates the database of this test file and points DATABASE_URL (and the app db) at it. */
export async function prepareTestDatabase(suffix: string): Promise<string> {
  if (!/^[a-z0-9_]{1,30}$/.test(suffix)) throw new Error('suffixe de base invalide');
  const name = `nuera_integrations_${suffix}`;
  const url = databaseUrl(name);
  const exists = await admin(async (db) => {
    const rows = await db.execute(sql`select 1 as found from pg_database where datname = ${name}`);
    return rows.length > 0;
  });
  if (!exists) await recreate(name);
  try {
    await runMigrations(url);
  } catch {
    // The initial migration was regenerated (schema changes before deployment): start afresh.
    await recreate(name);
    await runMigrations(url);
  }
  process.env.DATABASE_URL = url;
  delete (globalThis as { __nueraWebDb?: unknown }).__nueraWebDb;
  return url;
}

/** Empties every table touched by the integration lot and recreates the owner. */
export async function resetTables(): Promise<void> {
  const { db } = await import('@/server/db');
  await db.execute(
    sql.raw(
      'truncate table notifications, push_subscriptions, project_mcp_servers, mcp_servers, integrations, audit_log, permission_requests, session_events, sessions, worktrees, projects, "user" restart identity cascade',
    ),
  );
  await db.insert(user).values({ id: TEST_USER_ID, name: 'Nezar', email: 'owner@example.test', twoFactorEnabled: true });
}

/** Random 32-byte key for AES-256-GCM (crypto.ts reads it at call time). */
export function useTestEncryptionKey(): void {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  delete process.env.APP_ENCRYPTION_KEY_ID;
  delete process.env.APP_ENCRYPTION_PREVIOUS_KEYS;
}

/** Every text value stored in the integration tables, for « no plaintext secret » assertions. */
export async function dumpIntegrationTables(): Promise<string> {
  const { db } = await import('@/server/db');
  const rows = await db.execute(
    sql`select row_to_json(t)::text as j from (select * from integrations) t
        union all select row_to_json(t)::text from (select * from mcp_servers) t
        union all select row_to_json(t)::text from (select * from audit_log) t
        union all select row_to_json(t)::text from (select * from notifications) t`,
  );
  return rows.map((row) => String((row as { j: unknown }).j)).join('\n');
}

export async function closeTestDb(): Promise<void> {
  const holder = globalThis as { __nueraWebDb?: { $client?: { end: (options?: { timeout?: number }) => Promise<void> } } };
  await holder.__nueraWebDb?.$client?.end({ timeout: 5 }).catch(() => undefined);
  delete holder.__nueraWebDb;
}
