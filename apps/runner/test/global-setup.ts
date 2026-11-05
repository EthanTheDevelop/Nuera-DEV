import { sql } from 'drizzle-orm';
import { createDb } from '@nuera/db';
import { runMigrations } from '@nuera/db/migrate';

/**
 * Recreates the runner test database (`nuera_runner_test` on the local PostgreSQL of
 * `pnpm db:local`) and applies the migrations. Override with RUNNER_TEST_DATABASE_URL.
 * When PostgreSQL is not reachable, database suites are skipped (NUERA_TEST_DB=0).
 */
export default async function setup(): Promise<void> {
  const url = process.env.RUNNER_TEST_DATABASE_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/nuera_runner_test';
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Nom de base de test invalide : ${name}`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const db = createDb(admin.toString(), { max: 1, applicationName: 'nuera-runner-test-setup' });
  const client = (db as unknown as { $client: { end: (o?: { timeout?: number }) => Promise<void> } }).$client;
  try {
    await db.execute(sql.raw(`drop database if exists "${name}" with (force)`));
    await db.execute(sql.raw(`create database "${name}"`));
    await client.end({ timeout: 5 });
    await runMigrations(url);
    process.env.NUERA_TEST_DB = '1';
    process.env.RUNNER_TEST_DATABASE_URL = url;
  } catch (error) {
    await client.end({ timeout: 5 }).catch(() => undefined);
    process.env.NUERA_TEST_DB = '0';
    console.warn(`[runner tests] PostgreSQL indisponible (${(error as Error).message}) : suites base de données ignorées.`);
  }
}
