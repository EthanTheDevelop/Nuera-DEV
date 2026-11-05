import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate';

/**
 * Applies packages/db/drizzle on a brand-new database and checks the resulting schema.
 * Needs the local PostgreSQL (`pnpm db:local`, 127.0.0.1:54329); skipped with a warning when it
 * does not answer. Database: NUERA_MIGRATIONS_TEST_DB (default nuera_auth_migrations), dropped after.
 */

const ADMIN_URL = process.env.NUERA_PG_ADMIN_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/postgres';
const DB_NAME = process.env.NUERA_MIGRATIONS_TEST_DB ?? 'nuera_auth_migrations';
if (!/^[a-z0-9_]+$/.test(DB_NAME)) throw new Error(`Nom de base invalide : ${DB_NAME}`);

function urlFor(database: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function serverAvailable(): Promise<boolean> {
  const sql = postgres(ADMIN_URL, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    console.warn(`[migrations.test] PostgreSQL injoignable (${new URL(ADMIN_URL).host}) : test ignoré. Lancez \`pnpm db:local\`.`);
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

const available = await serverAvailable();

const EXPECTED_TABLES = [
  'user',
  'session',
  'account',
  'verification',
  'two_factor',
  'passkey',
  'app_settings',
  'integrations',
  'mcp_servers',
  'project_mcp_servers',
  'projects',
  'project_env_vars',
  'worktrees',
  'sessions',
  'session_events',
  'permission_requests',
  'operations',
  'command_runs',
  'pull_requests',
  'notifications',
  'push_subscriptions',
  'audit_log',
  'uptime_daily',
];

describe.skipIf(!available)('migrations Drizzle sur une base neuve', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const url = urlFor(DB_NAME);

  beforeAll(async () => {
    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop database if exists "${DB_NAME}" with (force)`);
    await admin.unsafe(`create database "${DB_NAME}"`);
    await runMigrations(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin) {
      await admin.unsafe(`drop database if exists "${DB_NAME}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  it('crée toutes les tables du schéma', async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public'`;
    const names = rows.map((row) => row.table_name);
    expect(names).toEqual(expect.arrayContaining(EXPECTED_TABLES));
    expect(names).toHaveLength(EXPECTED_TABLES.length);
  });

  it('two_factor et passkey ont les colonnes attendues par Better Auth 1.7', async () => {
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name in ('two_factor', 'passkey')`;
    const of = (table: string) => columns.filter((c) => c.table_name === table).map((c) => c.column_name);
    expect(of('two_factor')).toEqual(
      expect.arrayContaining(['secret', 'backup_codes', 'user_id', 'verified', 'failed_verification_count', 'locked_until']),
    );
    expect(of('passkey')).toEqual(
      expect.arrayContaining(['public_key', 'credential_id', 'counter', 'device_type', 'backed_up', 'transports', 'aaguid']),
    );
  });

  it("n'accepte qu'un seul propriétaire", async () => {
    await sql`insert into "user" (id, name, email) values ('owner-1', 'Propriétaire', 'owner@example.test')`;
    await expect(
      sql`insert into "user" (id, name, email) values ('owner-2', 'Intrus', 'intrus@example.test')`,
    ).rejects.toThrow(/user_single_owner_idx|duplicate key/);
    await sql`delete from "user"`;
  });

  it('garde app_settings sur une seule ligne (id = 1)', async () => {
    await sql`insert into app_settings (id) values (1)`;
    await expect(sql`insert into app_settings (id) values (2)`).rejects.toThrow(/app_settings_singleton/);
    const [row] = await sql<{ web_session_idle_hours: number; web_session_max_days: number }[]>`
      select web_session_idle_hours, web_session_max_days from app_settings where id = 1`;
    expect(row).toEqual({ web_session_idle_hours: 12, web_session_max_days: 30 });
  });

  it('est idempotente (aucune migration rejouée)', async () => {
    await expect(runMigrations(url)).resolves.toBeUndefined();
  });
});
