import postgres from 'postgres';

/**
 * Local PostgreSQL for database tests (`pnpm db:local`, 127.0.0.1:54329, superuser `nuera`).
 *
 * - NUERA_PG_ADMIN_URL: maintenance connection (default postgres://nuera:nuera@127.0.0.1:54329/postgres).
 * - NUERA_DB_TEST_PREFIX: prefix of the databases and roles created by the suites (default nuera_db_test),
 *   so that parallel runs on the shared cluster never collide.
 * - NUERA_REQUIRE_PG=1: an unreachable PostgreSQL FAILS the suites instead of skipping them (before a push).
 */

export const PG_ADMIN_URL = process.env.NUERA_PG_ADMIN_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/postgres';
export const TEST_DB_PREFIX = process.env.NUERA_DB_TEST_PREFIX ?? 'nuera_db_test';

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

/** `<prefix>_<suffix>`, validated as a plain PostgreSQL identifier (≤ 63 characters). */
export function testName(suffix: string): string {
  const name = `${TEST_DB_PREFIX}_${suffix}`;
  if (!IDENTIFIER.test(name)) throw new Error(`Nom de base ou de rôle de test invalide : ${name}`);
  return name;
}

export function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Identifiant PostgreSQL invalide : ${name}`);
  return name;
}

/** URL of `database` on the admin server, optionally with other credentials. */
export function databaseUrl(database: string, credentials?: { user: string; password: string }): string {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${assertIdentifier(database)}`;
  if (credentials) {
    url.username = credentials.user;
    url.password = credentials.password;
  }
  return url.toString();
}

/**
 * Text of a PostgreSQL failure, Drizzle's « Failed query » wrapper included (message, constraint
 * and SQLSTATE of the error and of its causes), for `toMatch` assertions.
 */
export function pgErrorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof Error) parts.push(current.message);
    const details = current as { constraint_name?: unknown; code?: unknown };
    if (typeof details.constraint_name === 'string') parts.push(details.constraint_name);
    if (typeof details.code === 'string') parts.push(details.code);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/** Resolves with the failure text of `promise`, or « aucune erreur » when it succeeds. */
export function pgFailure(promise: PromiseLike<unknown>): Promise<string> {
  return Promise.resolve(promise).then(
    () => 'aucune erreur',
    (error: unknown) => pgErrorText(error),
  );
}

export function pgRequired(): boolean {
  return process.env.NUERA_REQUIRE_PG === '1';
}

/**
 * true when PostgreSQL answers. Otherwise: warns and returns false (suite skipped), or throws when
 * NUERA_REQUIRE_PG=1 (suite failed).
 */
export async function pgAvailable(label: string): Promise<boolean> {
  const sql = postgres(PG_ADMIN_URL, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch (error) {
    const host = new URL(PG_ADMIN_URL).host;
    if (pgRequired()) {
      throw new Error(
        `[${label}] PostgreSQL injoignable (${host}) alors que NUERA_REQUIRE_PG=1 : ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    console.warn(`[${label}] PostgreSQL injoignable (${host}) : tests ignorés. Lancez \`pnpm db:local\`.`);
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

export function adminClient(): postgres.Sql {
  return postgres(PG_ADMIN_URL, { max: 1, onnotice: () => {} });
}

/** Drops (sessions included) and recreates an empty database. */
export async function recreateDatabase(admin: postgres.Sql, name: string): Promise<string> {
  assertIdentifier(name);
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.unsafe(`create database "${name}"`);
  return databaseUrl(name);
}

export async function dropDatabase(admin: postgres.Sql, name: string): Promise<void> {
  await admin.unsafe(`drop database if exists "${assertIdentifier(name)}" with (force)`);
}

/** Roles are cluster-wide: tests drop the login roles they create (after their databases). */
export async function dropRole(admin: postgres.Sql, name: string): Promise<void> {
  await admin.unsafe(`drop role if exists "${assertIdentifier(name)}"`);
}

/**
 * Login role member of `nuera_runner` (what the administration creates for a server), bound to
 * nothing until an `environments.db_role` names it.
 */
export async function createRunnerLoginRole(admin: postgres.Sql, name: string, password: string): Promise<void> {
  assertIdentifier(name);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(password)) throw new Error('Mot de passe de rôle de test invalide.');
  await admin.unsafe(`drop role if exists "${name}"`);
  await admin.unsafe(`create role "${name}" login password '${password}' in role "nuera_runner"`);
}
