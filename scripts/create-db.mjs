#!/usr/bin/env node
/**
 * Creates (or recreates with --reset) a database on the local PostgreSQL started by `pnpm db:local`.
 *   node scripts/create-db.mjs nuera_e2e
 *   node scripts/create-db.mjs nuera_e2e --reset
 * Uses NUERA_PG_ADMIN_URL (default postgres://nuera:nuera@127.0.0.1:54329/postgres).
 */
import postgres from 'postgres';

const name = process.argv[2];
const reset = process.argv.includes('--reset');
if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error('Usage : node scripts/create-db.mjs <nom_base> [--reset]  (a-z, 0-9, _)');
  process.exit(1);
}

const adminUrl = process.env.NUERA_PG_ADMIN_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/postgres';
const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
try {
  if (reset) {
    await sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`;
    await sql.unsafe(`drop database if exists "${name}"`);
  }
  const [row] = await sql`select 1 as found from pg_database where datname = ${name}`;
  if (!row) {
    await sql.unsafe(`create database "${name}"`);
    console.info(`Base créée : ${name}`);
  } else {
    console.info(`Base existante : ${name}`);
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  console.info(url.toString());
} finally {
  await sql.end({ timeout: 5 });
}
