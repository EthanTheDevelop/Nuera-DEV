/**
 * TEST-ONLY — database of a stack on the local PostgreSQL (`pnpm db:local`, port 54329).
 * Never touches nuera_dev: names are validated by config.assertDatabaseName.
 *
 * PostgreSQL roles are cluster-wide: the restricted login roles of a stack's servers
 * (`environments.db_role`, created by the administration or by the harness fallback) are named after
 * the stack database and dropped with it (dropDatabase, ensureDatabase({ reset })).
 */
import { createCipheriv, randomBytes } from 'node:crypto';
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

/** Login roles of a stack: `environments.db_role` of its database plus the harness-named ones (`<db>_env_*`). */
async function stackRoles(adminUrl: string, name: string): Promise<string[]> {
  const roles = new Set<string>();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  try {
    await withAdmin(url.toString(), async (db) => {
      const rows = (await db.execute(sql`select db_role from environments where db_role is not null`)) as unknown as Array<{ db_role: string }>;
      for (const row of rows) roles.add(row.db_role);
    });
  } catch {
    // no database or no table yet
  }
  await withAdmin(adminUrl, async (db) => {
    const rows = (await db.execute(sql`select rolname from pg_roles where rolname like ${`${name}\\_env\\_%`}`)) as unknown as Array<{ rolname: string }>;
    for (const row of rows) roles.add(row.rolname);
  });
  return [...roles].filter((role) => /^[a-z0-9_]{1,63}$/.test(role) && role !== 'nuera' && role !== 'nuera_runner' && role !== 'postgres');
}

async function dropWithRoles(adminUrl: string, name: string): Promise<void> {
  const roles = await stackRoles(adminUrl, name).catch(() => [] as string[]);
  await withAdmin(adminUrl, async (db) => {
    await db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`);
    await db.execute(sql.raw(`drop database if exists "${name}"`));
    // A role used by another database (never the case for a stack role) makes DROP ROLE fail: kept then.
    for (const role of roles) await db.execute(sql.raw(`drop role if exists "${role}"`)).catch(() => undefined);
  });
}

/** Creates the database (drops it, and the roles of its servers, first with `reset`). Returns true when it was created. */
export async function ensureDatabase(adminUrl: string, name: string, options: { reset?: boolean } = {}): Promise<boolean> {
  assertDatabaseName(name);
  if (options.reset) await dropWithRoles(adminUrl, name);
  return withAdmin(adminUrl, async (db) => {
    const exists = (await db.execute(sql`select 1 as found from pg_database where datname = ${name}`)).length > 0;
    if (!exists) await db.execute(sql.raw(`create database "${name}"`));
    return !exists;
  });
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  assertDatabaseName(name);
  await dropWithRoles(adminUrl, name);
}

/**
 * Applies the migrations (0000 → latest) and records sha256(RUNNER_TOKEN) of the default server, as
 * the `migrate` service does in production (it receives RUNNER_TOKEN).
 */
export async function migrate(url: string, runnerToken?: string): Promise<void> {
  await runMigrations(url, undefined, { runnerToken: runnerToken ?? null, log: () => undefined });
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

// ---------------------------------------------------------------------------------------------
// Fallbacks (used only while the administration routes do not exist on the web under test)
// ---------------------------------------------------------------------------------------------

/**
 * Secret in the web's LEGACY at-rest format (`v1:<iv>.<tag>.<data>`, AES-256-GCM, AAD = key id),
 * which the web keeps decrypting (MULTICOMPTE §11: « anciens formats toujours déchiffrés »).
 */
export function encryptLegacySecret(plain: string, base64Key: string, keyId = 'v1'): string {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('Clé de chiffrement de pile invalide (32 octets attendus).');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(keyId, 'utf8'));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${keyId}:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

/** Restricted login role of a server (member of `nuera_runner`), named after the stack database. */
export async function createServerRole(adminUrl: string, database: string, suffix: string): Promise<{ role: string; password: string }> {
  assertDatabaseName(database);
  const role = `${database}_env_${suffix}`.slice(0, 63);
  if (!/^[a-z0-9_]{1,63}$/.test(role)) throw new Error(`Nom de rôle invalide : ${role}`);
  const password = randomBytes(24).toString('base64url');
  await withAdmin(adminUrl, async (db) => {
    await db.execute(sql.raw(`drop role if exists "${role}"`));
    await db.execute(sql.raw(`create role "${role}" login password '${password}' in role "nuera_runner"`));
  });
  return { role, password };
}
