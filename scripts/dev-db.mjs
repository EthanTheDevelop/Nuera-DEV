#!/usr/bin/env node
/**
 * Local PostgreSQL 17 for development and tests, without Docker (embedded-postgres).
 *
 *   pnpm db:local                 # start (foreground), create nuera_dev + nuera_test if missing
 *   pnpm db:local -- --db foo     # also create database "foo"
 *   NUERA_PG_PORT=54330 pnpm db:local
 *
 * Data lives in .data/pg (git-ignored). Connection string:
 *   postgres://nuera:nuera@127.0.0.1:54329/nuera_dev
 * With Docker available you can use deploy/docker-compose.dev.yml instead.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.NUERA_PG_DATA ?? path.join(root, '.data', 'pg'));
const port = Number(process.env.NUERA_PG_PORT ?? 54329);
const user = 'nuera';
const password = 'nuera';

const extraDbs = [];
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--db' && process.argv[i + 1]) extraDbs.push(process.argv[(i += 1)]);
}
const databases = ['nuera_dev', 'nuera_test', ...extraDbs];

mkdirSync(path.dirname(dataDir), { recursive: true });

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
  onError: (message) => {
    const text = String(message ?? '').trim();
    if (text) console.error(`[postgres] ${text}`);
  },
});

let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  try {
    await pg.stop();
  } catch (error) {
    console.error('Arrêt de PostgreSQL :', error);
  }
  process.exit(code);
}

process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));

try {
  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
    console.info(`Initialisation du cluster PostgreSQL dans ${dataDir}…`);
    await pg.initialise();
  }
  await pg.start();
  const client = pg.getPgClient('postgres');
  await client.connect();
  for (const name of databases) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Nom de base invalide : ${name}`);
    const exists = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (exists.rowCount === 0) {
      await client.query(`create database "${name}"`);
      console.info(`Base créée : ${name}`);
    }
  }
  await client.end();
  console.info(`PostgreSQL prêt sur 127.0.0.1:${port}`);
  for (const name of databases) {
    console.info(`  postgres://${user}:${password}@127.0.0.1:${port}/${name}`);
  }
  console.info('Ctrl+C pour arrêter.');
} catch (error) {
  console.error('Impossible de démarrer PostgreSQL local :', error);
  await stop(1);
}
