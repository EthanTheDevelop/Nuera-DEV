import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export * from './schema';
export { schema };

export interface CreateDbOptions {
  /** Max pool size (default 10). */
  max?: number;
  /** Application name reported to PostgreSQL (pg_stat_activity). */
  applicationName?: string;
  /** Seconds to wait for a connection (default DATABASE_CONNECT_TIMEOUT or 30). */
  connectTimeout?: number;
}

function defaultConnectTimeout(): number {
  const value = Number(process.env.DATABASE_CONNECT_TIMEOUT);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

export function createDb(url: string, options: CreateDbOptions = {}) {
  const client = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 30,
    // 30 s (postgres.js default): a cold `next dev` start can block the event loop for more than
    // 10 s while modules evaluate, which made the first queries fail with CONNECT_TIMEOUT.
    connect_timeout: options.connectTimeout ?? defaultConnectTimeout(),
    onnotice: () => {},
    connection: { application_name: options.applicationName ?? 'nuera-dev' },
  });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
/** Transaction handle type (same query API as Database). */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Transaction;
