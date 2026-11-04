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
}

export function createDb(url: string, options: CreateDbOptions = {}) {
  const client = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: options.applicationName ?? 'nuera-dev' },
  });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
/** Transaction handle type (same query API as Database). */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Transaction;
