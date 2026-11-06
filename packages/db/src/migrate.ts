import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { sha256Hex } from './tokens';

export { sha256Hex };

export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

/** Session advisory lock taken around the migrations: two `migrate` runs never overlap. */
export const MIGRATION_LOCK_NAME = 'nuera:migrate';

export interface RunMigrationsOptions {
  /**
   * RUNNER_TOKEN of the default server (`config_source = 'env'`). Its sha256 is recorded in
   * `environments.token_hash`, which is how that runner finds its own row. The token itself is never
   * stored nor logged.
   */
  runnerToken?: string | null;
  /** Progress lines (French). Default: console. */
  log?: (message: string) => void;
  /** Warnings and errors that must not fail the migration (French). Default: console.error. */
  warn?: (message: string) => void;
}

/** What happened to the fingerprint of the default server's token. */
export type DefaultRunnerTokenOutcome = 'recorded' | 'updated' | 'unchanged' | 'no_default_server' | 'conflict' | 'failed';

/**
 * Apply every pending migration of packages/db/drizzle (one transaction, under an advisory lock on a
 * single connection), then record the fingerprint of the default server's token. Idempotent.
 */
export async function runMigrations(url: string, migrationsFolder = MIGRATIONS_FOLDER, options: RunMigrationsOptions = {}) {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // max: 1 — the lock and drizzle's migration transaction share the same connection.
    await client`select pg_advisory_lock(hashtextextended(${MIGRATION_LOCK_NAME}, 0))`;
    try {
      await migrate(drizzle(client), { migrationsFolder });
      const token = options.runnerToken?.trim();
      if (token) {
        await recordDefaultRunnerToken(client, token, {
          log: options.log ?? ((message) => console.log(message)),
          warn: options.warn ?? ((message) => console.error(message)),
        });
      }
    } finally {
      await client`select pg_advisory_unlock(hashtextextended(${MIGRATION_LOCK_NAME}, 0))`.catch(() => {});
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * Records sha256(RUNNER_TOKEN) on the default server. Its token is RUNNER_TOKEN by definition
 * (`config_source = 'env'`), so a changed RUNNER_TOKEN (rotation) updates the fingerprint too;
 * otherwise the runner would stay unregistered. Never throws: a failure here must not stop the
 * application from starting (the runner then waits, health only).
 */
export async function recordDefaultRunnerToken(
  sql: postgres.Sql,
  token: string,
  output: { log: (message: string) => void; warn: (message: string) => void },
): Promise<DefaultRunnerTokenOutcome> {
  const hash = sha256Hex(token);
  try {
    const [current] = await sql<{ id: string; token_hash: string | null }[]>`
      select id, token_hash from environments where config_source = 'env' and is_default limit 1`;
    if (!current) {
      output.warn("Aucun serveur par défaut : l'empreinte du jeton du runner n'a pas été enregistrée.");
      return 'no_default_server';
    }
    if (current.token_hash === hash) return 'unchanged';
    const updated = await sql`
      update environments set token_hash = ${hash}, updated_at = now()
      where id = ${current.id} and token_hash is not distinct from ${current.token_hash}`;
    if (updated.count === 0) return 'unchanged';
    if (current.token_hash === null) {
      output.log('Empreinte du jeton du serveur par défaut enregistrée.');
      return 'recorded';
    }
    output.log('Empreinte du jeton du serveur par défaut mise à jour (RUNNER_TOKEN a changé).');
    return 'updated';
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === '23505') {
      output.warn(
        "RUNNER_TOKEN est déjà le jeton d'un autre serveur : l'empreinte du serveur par défaut n'a pas été enregistrée.",
      );
      return 'conflict';
    }
    output.warn(
      `Empreinte du jeton du serveur par défaut non enregistrée : ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'failed';
  }
}
