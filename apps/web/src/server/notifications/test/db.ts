/**
 * Test-only helpers of the notifications, push, journal and settings suites: one PostgreSQL
 * database per test file (`<NUERA_DB_TEST_PREFIX or nuera_c2b>_<suite>`) on the local cluster
 * (`pnpm db:local`), recreated and migrated by `prepareSuiteDatabase`, dropped by `dropSuiteDatabase`.
 * The app database singleton (`@/server/db`) is pointed at it through DATABASE_URL.
 *
 *   const available = await pgAvailable('notifications.test');           // NUERA_REQUIRE_PG=1 ⇒ failure
 *   describe.skipIf(!available)('…', () => {
 *     beforeAll(() => prepareSuiteDatabase('notifications'));
 *     beforeEach(async () => ({ a, b } = await resetAccounts()));
 *     afterAll(() => dropSuiteDatabase('notifications'));
 *   });
 *
 * Never points at nuera_dev: the database name is always derived here.
 */
import { randomBytes } from 'node:crypto';
import { runMigrations } from '@nuera/db/migrate';
import { adminClient, assertIdentifier, databaseUrl, dropDatabase, recreateDatabase, seedMember, seedOwner, type SeededAccount } from '@nuera/db/test';
import { sql } from 'drizzle-orm';

export { pgAvailable } from '@nuera/db/test';

const PREFIX = process.env.NUERA_DB_TEST_PREFIX ?? 'nuera_c2b';

function suiteName(suite: string): string {
  return assertIdentifier(`${PREFIX}_${suite}`);
}

type HeldDb = { $client?: { end: (options?: { timeout?: number }) => Promise<void> } };
const holder = globalThis as { __nueraWebDb?: HeldDb };

async function closeAppDb(): Promise<void> {
  await holder.__nueraWebDb?.$client?.end({ timeout: 5 }).catch(() => undefined);
  delete holder.__nueraWebDb;
}

/** Recreates and migrates the suite database, then points DATABASE_URL (and the app db) at it. */
export async function prepareSuiteDatabase(suite: string): Promise<string> {
  const name = suiteName(suite);
  const admin = adminClient();
  try {
    await recreateDatabase(admin, name);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = databaseUrl(name);
  await runMigrations(url, undefined, { log: () => {}, warn: () => {} });
  await closeAppDb();
  process.env.DATABASE_URL = url;
  return url;
}

export async function dropSuiteDatabase(suite: string): Promise<void> {
  await closeAppDb();
  const admin = adminClient();
  try {
    await dropDatabase(admin, suiteName(suite));
  } finally {
    await admin.end({ timeout: 5 });
  }
}

export interface TwoAccounts {
  /** The owner, its personal space and the default server « VPS-3 ». */
  a: SeededAccount;
  /** A member with its own space and server. */
  b: SeededAccount;
}

/**
 * Empties every account (TRUNCATE "user" CASCADE also empties spaces, servers, notifications,
 * push subscriptions…) and the journal, then seeds two accounts in two spaces on two servers.
 */
export async function resetAccounts(): Promise<TwoAccounts> {
  const { db } = await import('@/server/db');
  await db.execute(sql.raw('truncate table audit_log, environments, "user" restart identity cascade'));
  await db.execute(sql.raw('insert into app_settings (id) values (1) on conflict (id) do nothing'));
  await db.execute(
    sql.raw(
      'update app_settings set web_session_idle_hours = 12, web_session_max_days = 30, invitation_ttl_hours = 48, force_block_bypass_permissions = false where id = 1',
    ),
  );
  const a = await seedOwner(db, { id: 'user_a', email: 'ethan@example.test', name: 'Ethan', spaceName: "Espace d'Ethan" });
  const b = await seedMember(db, {
    id: 'user_b',
    email: 'camille@example.test',
    name: 'Camille',
    spaceName: 'Espace de Camille',
    environment: { name: 'VPS-4' },
  });
  return { a, b };
}

/** Random 32-byte key for AES-256-GCM (crypto.ts reads it at call time). */
export function useTestEncryptionKey(): void {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  delete process.env.APP_ENCRYPTION_KEY_ID;
  delete process.env.APP_ENCRYPTION_PREVIOUS_KEYS;
}
