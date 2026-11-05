import 'server-only';
import { createDb, type Database } from '@nuera/db';

/**
 * Database singleton for the web app (Drizzle + postgres.js).
 *
 * - One small pool per process (DATABASE_POOL_MAX, default 5: a single owner, few concurrent requests).
 * - Cached on globalThis outside production so Next dev HMR does not open a new pool per reload.
 * - Created lazily on first use: importing this module never connects nor throws, so `next build`
 *   works without DATABASE_URL; the first query fails with a clear message if it is missing.
 */
const globalForDb = globalThis as unknown as { __nueraWebDb?: Database };

function createWebDb(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL manquant : renseignez-le dans .env (voir .env.example).');
  }
  const max = Number.parseInt(process.env.DATABASE_POOL_MAX ?? '', 10);
  return createDb(url, {
    max: Number.isFinite(max) && max > 0 ? max : 5,
    applicationName: 'nuera-web',
  });
}

function getDb(): Database {
  if (!globalForDb.__nueraWebDb) {
    globalForDb.__nueraWebDb = createWebDb();
  }
  return globalForDb.__nueraWebDb;
}

export const db: Database = new Proxy({} as Database, {
  get(_target, property) {
    const instance = getDb();
    const value: unknown = Reflect.get(instance, property, instance);
    // Bind the query-builder methods (prototype), never own function-valued properties: `$client`
    // is the postgres.js client, a callable object whose own methods (`end`, `unsafe`…) must stay reachable.
    if (typeof value !== 'function' || Object.prototype.hasOwnProperty.call(instance, property)) return value;
    return (value as (...args: unknown[]) => unknown).bind(instance);
  },
  has(_target, property) {
    return Reflect.has(getDb(), property);
  },
});
