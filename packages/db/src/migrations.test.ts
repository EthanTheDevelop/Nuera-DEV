import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate';
import { adminClient, databaseUrl, dropDatabase, pgAvailable, recreateDatabase, testName } from './test/pg';
import { sha256Hex } from './tokens';

/**
 * Applies packages/db/drizzle on a brand-new database and checks the resulting schema.
 * Needs the local PostgreSQL (`pnpm db:local`, 127.0.0.1:54329); skipped with a warning when it
 * does not answer (failed with NUERA_REQUIRE_PG=1). Database: NUERA_MIGRATIONS_TEST_DB (default
 * <NUERA_DB_TEST_PREFIX>_migrations), dropped after.
 */

const DB_NAME = process.env.NUERA_MIGRATIONS_TEST_DB ?? testName('migrations');
const LOCK_DB_NAME = testName('migrations_lock');

const available = await pgAvailable('migrations.test');

const EXPECTED_TABLES = [
  'user',
  'session',
  'account',
  'verification',
  'two_factor',
  'passkey',
  'spaces',
  'space_members',
  'environments',
  'invitations',
  'space_settings',
  'user_preferences',
  'github_sources',
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

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function readJournal(): JournalEntry[] {
  return (JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] })
    .entries;
}

describe('fichiers de migration', () => {
  it('0000 reste celle appliquée en production (jamais régénérée)', () => {
    const sql = readFileSync(path.join(MIGRATIONS_FOLDER, '0000_material_hiroim.sql'));
    expect(createHash('sha256').update(sql).digest('hex')).toBe('2dedf7a2a243ac374c3b093a40bb54e72302d6123a096422d5a7f05f755062d3');
    const [first] = readJournal();
    expect(first).toEqual({ idx: 0, version: '7', when: 1793852411456, tag: '0000_material_hiroim', breakpoints: true });
  });

  it("enchaîne 0001 → 0005 dans l'ordre, avec des dates croissantes", () => {
    const entries = readJournal();
    expect(entries.map((entry) => entry.tag)).toEqual([
      '0000_material_hiroim',
      '0001_tenancy_expand',
      '0002_tenancy_backfill',
      '0003_tenancy_enforce',
      '0004_runner_roles',
      '0005_runner_scope',
    ]);
    entries.forEach((entry, index) => {
      expect(entry.idx).toBe(index);
      expect(entry.breakpoints).toBe(true);
    });
    for (let index = 1; index < entries.length; index += 1) {
      expect(entries[index]!.when).toBeGreaterThan(entries[index - 1]!.when);
    }
  });

  it('chaque morceau entre deux « statement-breakpoint » porte une instruction', () => {
    for (const entry of readJournal()) {
      const chunks = readFileSync(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), 'utf8').split('--> statement-breakpoint');
      for (const chunk of chunks) {
        const code = chunk
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim();
        expect(code, `${entry.tag} : morceau vide`).not.toBe('');
      }
    }
  });

  it("0001 et 0005 limitent l'attente des verrous ; 0003 et 0005 n'ajoutent aucune colonne", () => {
    const expand = readFileSync(path.join(MIGRATIONS_FOLDER, '0001_tenancy_expand.sql'), 'utf8');
    expect(expand.startsWith("SET LOCAL lock_timeout = '10s';--> statement-breakpoint")).toBe(true);
    expect(expand).not.toMatch(/DROP COLUMN/i);
    const enforce = readFileSync(path.join(MIGRATIONS_FOLDER, '0003_tenancy_enforce.sql'), 'utf8');
    expect(enforce).not.toMatch(/ADD COLUMN/i);
    expect(enforce).not.toMatch(/DROP COLUMN/i);
    const scope = readFileSync(path.join(MIGRATIONS_FOLDER, '0005_runner_scope.sql'), 'utf8');
    expect(scope.startsWith("SET LOCAL lock_timeout = '10s';--> statement-breakpoint")).toBe(true);
    expect(scope).not.toMatch(/ADD COLUMN|DROP COLUMN/i);
  });
});

describe.skipIf(!available)('migrations Drizzle sur une base neuve', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const url = databaseUrl(DB_NAME);

  beforeAll(async () => {
    admin = adminClient();
    await recreateDatabase(admin, DB_NAME);
    await runMigrations(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin) {
      await dropDatabase(admin, DB_NAME);
      await dropDatabase(admin, LOCK_DB_NAME);
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

  it('user : rôle par défaut « member », colonnes ajoutées nullables ou avec défaut (Better Auth)', async () => {
    const columns = await sql<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'user' and column_name in ('role', 'disabled_at', 'deleted_at')
      order by column_name`;
    expect(columns).toEqual([
      { column_name: 'deleted_at', is_nullable: 'YES', column_default: null },
      { column_name: 'disabled_at', is_nullable: 'YES', column_default: null },
      { column_name: 'role', is_nullable: 'NO', column_default: "'member'::text" },
    ]);
  });

  it('accepte plusieurs comptes mais un seul propriétaire', async () => {
    await sql`insert into "user" (id, name, email, role) values ('owner-1', 'Propriétaire', 'owner@example.test', 'owner')`;
    await sql`insert into "user" (id, name, email) values ('member-2', 'Camille', 'camille@example.test')`;
    await sql`insert into "user" (id, name, email, role) values ('admin-3', 'Alex', 'alex@example.test', 'admin')`;
    const [member] = await sql<{ role: string }[]>`select role from "user" where id = 'member-2'`;
    expect(member?.role).toBe('member');
    await expect(
      sql`insert into "user" (id, name, email, role) values ('owner-4', 'Intrus', 'intrus@example.test', 'owner')`,
    ).rejects.toThrow(/user_owner_idx/);
    await expect(sql`update "user" set role = 'owner' where id = 'admin-3'`).rejects.toThrow(/user_owner_idx/);
    await expect(
      sql`insert into "user" (id, name, email) values ('member-5', 'Doublon', 'camille@example.test')`,
    ).rejects.toThrow(/user_email_unique/);
    await sql`delete from "user"`;
  });

  it('garde app_settings sur une seule ligne (id = 1), créée par la migration avec ses défauts', async () => {
    const rows = await sql<
      { id: number; web_session_idle_hours: number; web_session_max_days: number; invitation_ttl_hours: number; force_block_bypass_permissions: boolean }[]
    >`select id, web_session_idle_hours, web_session_max_days, invitation_ttl_hours, force_block_bypass_permissions from app_settings`;
    expect(rows).toEqual([
      { id: 1, web_session_idle_hours: 12, web_session_max_days: 30, invitation_ttl_hours: 48, force_block_bypass_permissions: false },
    ]);
    await expect(sql`insert into app_settings (id) values (2)`).rejects.toThrow(/app_settings_singleton/);
    await expect(sql`insert into app_settings (id) values (1)`).rejects.toThrow(/app_settings_pkey/);
  });

  it('crée le serveur par défaut « VPS-3 », non attribué, lu dans RUNNER_URL / RUNNER_TOKEN', async () => {
    const rows = await sql`
      select space_id, name, status, config_source, is_default, url, token_hash, max_concurrent_sessions,
             max_concurrent_sessions_cap, session_memory_limit_mb, capabilities
      from environments`;
    expect(rows).toEqual([
      {
        space_id: null,
        name: 'VPS-3',
        status: 'pending',
        config_source: 'env',
        is_default: true,
        url: null,
        token_hash: null,
        max_concurrent_sessions: 4,
        max_concurrent_sessions_cap: 16,
        session_memory_limit_mb: null,
        capabilities: {},
      },
    ]);
    const [counts] = await sql<{ spaces: string; users: string }[]>`
      select (select count(*) from spaces) as spaces, (select count(*) from "user") as users`;
    expect(counts).toEqual({ spaces: '0', users: '0' });
  });

  it('active la sécurité au niveau des lignes sur les tables du runner', async () => {
    const rows = await sql<{ relname: string }[]>`
      select relname from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity
      order by relname`;
    expect(rows.map((row) => row.relname)).toEqual([
      'command_runs',
      'environments',
      'operations',
      'permission_requests',
      'projects',
      'session_events',
      'sessions',
      'space_settings',
      'uptime_daily',
      'worktrees',
    ]);
    const [role] = await sql<{ rolcanlogin: boolean }[]>`select rolcanlogin from pg_roles where rolname = 'nuera_runner'`;
    expect(role).toEqual({ rolcanlogin: false });
  });

  it("enregistre l'empreinte de RUNNER_TOKEN sur le serveur par défaut, sans jamais l'afficher", async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    await runMigrations(url, undefined, { runnerToken: 'jeton-du-runner', log, warn: log });
    const hashOf = async () => (await sql<{ token_hash: string | null }[]>`select token_hash from environments where is_default`)[0]?.token_hash;
    expect(await hashOf()).toBe(sha256Hex('jeton-du-runner'));
    await runMigrations(url, undefined, { runnerToken: '  jeton-du-runner  ', log, warn: log });
    await runMigrations(url, undefined, { runnerToken: 'nouveau-jeton', log, warn: log });
    expect(await hashOf()).toBe(sha256Hex('nouveau-jeton'));
    await runMigrations(url, undefined, { runnerToken: '', log, warn: log });
    expect(await hashOf()).toBe(sha256Hex('nouveau-jeton'));
    expect(lines).toEqual([
      'Empreinte du jeton du serveur par défaut enregistrée.',
      'Empreinte du jeton du serveur par défaut mise à jour (RUNNER_TOKEN a changé).',
    ]);
    expect(lines.join('\n')).not.toContain('jeton-du-runner');
    await sql`update environments set token_hash = null where is_default`;
  });

  it('est idempotente (aucune migration rejouée)', async () => {
    await expect(runMigrations(url)).resolves.toBeUndefined();
    const [row] = await sql<{ count: string }[]>`select count(*) from drizzle.__drizzle_migrations`;
    expect(row?.count).toBe(String(readJournal().length));
    const [environments] = await sql<{ count: string }[]>`select count(*) from environments`;
    expect(environments?.count).toBe('1');
  });

  it('sérialise deux migrations lancées en même temps (verrou consultatif)', async () => {
    const lockUrl = await recreateDatabase(admin, LOCK_DB_NAME);
    await expect(Promise.all([runMigrations(lockUrl), runMigrations(lockUrl)])).resolves.toEqual([undefined, undefined]);
    const other = postgres(lockUrl, { max: 1, onnotice: () => {} });
    try {
      const [row] = await other<{ count: string }[]>`select count(*) from drizzle.__drizzle_migrations`;
      expect(row?.count).toBe(String(readJournal().length));
      const [environments] = await other<{ count: string }[]>`select count(*) from environments where is_default`;
      expect(environments?.count).toBe('1');
    } finally {
      await other.end({ timeout: 5 });
    }
  });
});
