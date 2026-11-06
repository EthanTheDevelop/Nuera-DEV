import 'server-only';
import { randomBytes } from 'node:crypto';
import type { DbOrTx } from '@nuera/db';
import { sql } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';

/**
 * Restricted PostgreSQL login roles of the runners (docs/MULTICOMPTE.md §11): `nuera_env_<8 hex>`,
 * member of `nuera_runner` (migration 0004: runner tables only, row-level security by server, no
 * access to accounts, invitations, sources, integrations, MCP, variables, notifications, push or
 * journal). The role is created by the web when a server is registered (or when the default server
 * is restricted) and recorded in `environments.db_role`; its DSN is shown once.
 *
 * Every role gets a CONNECTION LIMIT (NUERA_RUNNER_DB_CONNECTION_LIMIT, 20 by default: the runner's
 * pool NUERA_DB_POOL_MAX, 5 by default, plus its lease connection and a margin), so that one server
 * can never exhaust `max_connections` of the whole instance, plus role-level `statement_timeout` and
 * `idle_in_transaction_session_timeout` (a forgotten transaction never holds its locks for ever).
 *
 * PostgreSQL does not accept bind parameters in CREATE / ALTER ROLE: the name and the password are
 * generated here (hex / base64url only), the limit is an integer within bounds, the settings are
 * fixed literals, and everything is re-validated before being inlined.
 */

export const RUNNER_GROUP_ROLE = 'nuera_runner';
const ROLE_NAME = /^nuera_env_[0-9a-f]{8}$/;
const ROLE_PASSWORD = /^[A-Za-z0-9_-]{32,128}$/;
const SETTING_VALUE = /^\d{1,6}(ms|s|min)$/;

/** Bounds of NUERA_RUNNER_DB_CONNECTION_LIMIT: at least the runner's smallest pool (2) + lease + probe. */
export const RUNNER_ROLE_CONNECTION_LIMIT = { min: 4, max: 500, fallback: 20 } as const;

/** Role-level settings of every runner role (`ALTER ROLE … SET`): fixed literals, never user input. */
export const RUNNER_ROLE_SETTINGS = {
  statement_timeout: '2min',
  idle_in_transaction_session_timeout: '1min',
} as const;

export function generateRunnerRoleName(): string {
  return `nuera_env_${randomBytes(4).toString('hex')}`;
}

export function generateRunnerRolePassword(): string {
  return randomBytes(32).toString('base64url');
}

/** CONNECTION LIMIT of the runner roles: NUERA_RUNNER_DB_CONNECTION_LIMIT within bounds, else 20. */
export function runnerRoleConnectionLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.NUERA_RUNNER_DB_CONNECTION_LIMIT?.trim();
  if (!raw || !/^\d{1,6}$/.test(raw)) return RUNNER_ROLE_CONNECTION_LIMIT.fallback;
  const value = Number.parseInt(raw, 10);
  return Math.min(
    RUNNER_ROLE_CONNECTION_LIMIT.max,
    Math.max(RUNNER_ROLE_CONNECTION_LIMIT.min, value),
  );
}

function assertRole(name: string, password?: string): void {
  if (!ROLE_NAME.test(name)) throw new AppError('INTERNAL', 'Nom de rôle PostgreSQL invalide.');
  if (password !== undefined && !ROLE_PASSWORD.test(password))
    throw new AppError('INTERNAL', 'Mot de passe de rôle PostgreSQL invalide.');
}

/** The limit, re-validated as an integer within bounds before being inlined. */
function connectionLimit(): number {
  const limit = runnerRoleConnectionLimit();
  if (
    !Number.isSafeInteger(limit) ||
    limit < RUNNER_ROLE_CONNECTION_LIMIT.min ||
    limit > RUNNER_ROLE_CONNECTION_LIMIT.max
  ) {
    throw new AppError('INTERNAL', 'Limite de connexions du rôle PostgreSQL invalide.');
  }
  return limit;
}

/** The French refusal shown when the database account of Nuera Dev may not manage roles. */
export function roleRefusal(error: unknown): AppError {
  const detail = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  return new AppError(
    'CONFLICT',
    "PostgreSQL refuse de créer l'accès restreint du serveur : rien n'a été enregistré.",
    {
      detail: `Le compte de base de données de Nuera Dev (DATABASE_URL) doit pouvoir créer des rôles (CREATEROLE) et administrer le rôle ${RUNNER_GROUP_ROLE} (créé par la migration 0004). Donnez-lui ces droits, puis réessayez. Réponse de PostgreSQL : ${detail}`,
      untouched: "Aucun serveur ni aucun rôle n'a été créé.",
    },
  );
}

/** Connection limit and role-level timeouts of an existing runner role (idempotent). */
export async function applyRunnerRoleLimits(tx: DbOrTx, name: string): Promise<void> {
  assertRole(name);
  await tx.execute(sql.raw(`alter role "${name}" with connection limit ${connectionLimit()}`));
  for (const [setting, value] of Object.entries(RUNNER_ROLE_SETTINGS)) {
    if (!SETTING_VALUE.test(value))
      throw new AppError('INTERNAL', 'Réglage de rôle PostgreSQL invalide.');
    await tx.execute(sql.raw(`alter role "${name}" set ${setting} = '${value}'`));
  }
}

/** CREATE ROLE … LOGIN CONNECTION LIMIT … PASSWORD … IN ROLE nuera_runner (inside the caller's transaction). */
export async function createRunnerRole(tx: DbOrTx, name: string, password: string): Promise<void> {
  assertRole(name, password);
  await tx.execute(
    sql.raw(
      `create role "${name}" login connection limit ${connectionLimit()} password '${password}' in role "${RUNNER_GROUP_ROLE}"`,
    ),
  );
  await applyRunnerRoleLimits(tx, name);
}

/** New password for an existing runner role (and LOGIN again, with its limits). */
export async function resetRunnerRolePassword(
  tx: DbOrTx,
  name: string,
  password: string,
): Promise<void> {
  assertRole(name, password);
  await tx.execute(
    sql.raw(
      `alter role "${name}" with login connection limit ${connectionLimit()} password '${password}'`,
    ),
  );
  await applyRunnerRoleLimits(tx, name);
}

/** A retired server's role can no longer connect (kept: `environments.db_role` stays unique). */
export async function disableRunnerRoleLogin(tx: DbOrTx, name: string | null): Promise<void> {
  if (!name || !ROLE_NAME.test(name)) return;
  await tx.execute(sql.raw(`alter role "${name}" with nologin`));
}

export interface ClosedConnections {
  /** Backends of the role terminated now. */
  closed: number;
  /** Backends PostgreSQL refused to terminate (the web's role lacks the right): still open. */
  refused: number;
}

type Executor = Pick<DbOrTx, 'execute'>;

/**
 * Closes the open connections of a runner role, after NOLOGIN (retired server, deleted account) or
 * after a new password (the old DSN stops working now, not at the next reconnection). Called AFTER
 * the transaction that changed the role. Terminating another role's backend needs superuser, the
 * `pg_signal_backend` role, or the privileges of that role (CREATEROLE alone gives ADMIN without
 * INHERIT since PostgreSQL 16): when PostgreSQL refuses, the connection stays open and the refusal is
 * counted (journal, warning in the logs of the web) — never thrown, the administration action happened.
 */
export async function closeRunnerRoleConnections(
  name: string | null,
  executor: Executor = db,
): Promise<ClosedConnections> {
  const result: ClosedConnections = { closed: 0, refused: 0 };
  if (!name || !ROLE_NAME.test(name)) return result;
  let pids: number[];
  try {
    const rows = (await executor.execute(
      sql`select pid from pg_catalog.pg_stat_activity where usename = ${name} and pid <> pg_catalog.pg_backend_pid()`,
    )) as unknown as Array<{ pid: number | string }>;
    pids = Array.from(rows, (row) => Number(row.pid)).filter(
      (pid) => Number.isSafeInteger(pid) && pid > 0,
    );
  } catch (error) {
    console.warn(
      `[serveurs] connexions du rôle ${name} illisibles`,
      error instanceof Error ? error.message : error,
    );
    return result;
  }
  for (const pid of pids) {
    try {
      const rows = (await executor.execute(
        sql`select pg_catalog.pg_terminate_backend(${pid}::int) as ok`,
      )) as unknown as Array<{ ok: boolean }>;
      // false: the backend ended meanwhile (nothing left open).
      if (rows[0]?.ok) result.closed += 1;
    } catch (error) {
      result.refused += 1;
      console.warn(
        `[serveurs] PostgreSQL refuse de fermer une connexion du rôle ${name}`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (result.refused > 0) {
    console.warn(
      `[serveurs] ${result.refused} connexion(s) du rôle ${name} restent ouvertes : donnez le rôle pg_signal_backend au compte de DATABASE_URL, ou fermez-les à la main.`,
    );
  }
  return result;
}

/** Journal note when PostgreSQL refused to close connections of a runner role (empty otherwise). */
export function refusedConnectionsNote(refused: number): string {
  return refused > 0
    ? ` · ${refused} connexion(s) à la base encore ouverte(s) : PostgreSQL refuse de les fermer`
    : '';
}

/**
 * DSN of the runner (RUNNER_DATABASE_URL): host, port, database and options of the web's
 * DATABASE_URL, with the restricted role and its password.
 */
export function runnerDatabaseUrl(
  name: string,
  password: string,
  base: string | undefined = process.env.DATABASE_URL,
): string {
  assertRole(name, password);
  if (!base)
    throw new AppError(
      'INTERNAL',
      "DATABASE_URL manquant : impossible de construire l'accès du serveur.",
    );
  const url = new URL(base);
  url.username = name;
  url.password = password;
  // Options that name another role (or carry a password) never travel with the restricted DSN.
  for (const key of ['user', 'password', 'options']) url.searchParams.delete(key);
  return url.toString();
}
