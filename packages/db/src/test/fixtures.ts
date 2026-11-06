import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../index';
import { environments, spaceMembers, spaceSettings, spaces, user, userPreferences } from '../schema';
import type { EnvironmentConfigSource, EnvironmentStatus, InstanceRole } from '../schema/types';

/**
 * Test fixtures for the multi-account model (tests only: `@nuera/db/test`).
 *
 *   const owner = await seedOwner(db, { id: TEST_USER_ID, email: 'owner@example.test' });
 *   const other = await seedMember(db, { email: 'membre@example.test' });            // own server
 *   const lonely = await seedMember(db, { email: 'c@example.test', environment: false }); // no server
 *   await db.insert(projects).values({ …, spaceId: owner.spaceId, environmentId: owner.environmentId! });
 *
 * `TRUNCATE "user" … CASCADE` also empties spaces, environments and everything below them (the
 * default server created by the migration included): seed again after each reset.
 */

export interface SeededAccount {
  userId: string;
  email: string;
  spaceId: string;
  /** null when the account has no server. */
  environmentId: string | null;
}

export interface SeedEnvironmentOptions {
  /** null = not assigned to a space. */
  spaceId: string | null;
  id?: string;
  /** Default « VPS-3 » for the default server, « Serveur de test » otherwise. */
  name?: string;
  location?: string | null;
  /** Default: `active` when assigned, `pending` otherwise. */
  status?: EnvironmentStatus;
  isDefault?: boolean;
  /** Default: `env` for the default server, `db` otherwise. */
  configSource?: EnvironmentConfigSource;
  url?: string | null;
  tokenHash?: string | null;
  dbRole?: string | null;
  maxConcurrentSessions?: number;
  sessionMemoryLimitMb?: number | null;
}

export async function seedEnvironment(db: DbOrTx, options: SeedEnvironmentOptions): Promise<string> {
  const isDefault = options.isDefault ?? false;
  const [row] = await db
    .insert(environments)
    .values({
      ...(options.id ? { id: options.id } : {}),
      spaceId: options.spaceId,
      name: options.name ?? (isDefault ? 'VPS-3' : 'Serveur de test'),
      location: options.location ?? null,
      status: options.status ?? (options.spaceId ? 'active' : 'pending'),
      isDefault,
      configSource: options.configSource ?? (isDefault ? 'env' : 'db'),
      url: options.url ?? null,
      tokenHash: options.tokenHash ?? null,
      dbRole: options.dbRole ?? null,
      ...(options.maxConcurrentSessions !== undefined ? { maxConcurrentSessions: options.maxConcurrentSessions } : {}),
      sessionMemoryLimitMb: options.sessionMemoryLimitMb ?? null,
    })
    .returning({ id: environments.id });
  return row!.id;
}

/** Personal space of `userId` with its membership, settings and the account's preferences. */
export async function seedSpace(db: DbOrTx, options: { userId: string; name?: string }): Promise<string> {
  const [row] = await db
    .insert(spaces)
    .values({ name: options.name ?? 'Espace de test', kind: 'personal', ownerUserId: options.userId })
    .returning({ id: spaces.id });
  const spaceId = row!.id;
  await db.insert(spaceMembers).values({ spaceId, userId: options.userId, role: 'owner' });
  await db.insert(spaceSettings).values({ spaceId });
  await db.insert(userPreferences).values({ userId: options.userId }).onConflictDoNothing();
  return spaceId;
}

export interface SeedAccountOptions {
  id?: string;
  email?: string;
  name?: string;
  /** Default true (2FA is mandatory). */
  twoFactorEnabled?: boolean;
  spaceName?: string;
}

async function insertUser(db: DbOrTx, role: InstanceRole, options: SeedAccountOptions): Promise<{ id: string; email: string }> {
  const id = options.id ?? `user_${randomUUID().replaceAll('-', '')}`;
  const email = (options.email ?? `${id}@example.test`).toLowerCase();
  await db.insert(user).values({
    id,
    name: options.name ?? 'Compte de test',
    email,
    role,
    twoFactorEnabled: options.twoFactorEnabled ?? true,
  });
  return { id, email };
}

/**
 * The owner, its personal space and the default server (`config_source = 'env'`, « VPS-3 »,
 * `active`), as the migration leaves an existing installation. The default server left unassigned
 * by a fresh migration is reused (as /configuration does); otherwise it is created.
 */
export async function seedOwner(
  db: DbOrTx,
  options: SeedAccountOptions & { environment?: Partial<Omit<SeedEnvironmentOptions, 'spaceId' | 'isDefault' | 'configSource'>> } = {},
): Promise<SeededAccount> {
  const account = await insertUser(db, 'owner', options);
  const spaceId = await seedSpace(db, { userId: account.id, name: options.spaceName ?? 'Espace du propriétaire' });
  const wanted = options.environment ?? {};
  const [unassigned] = await db
    .update(environments)
    .set({
      ...(wanted.id !== undefined ? { id: wanted.id } : {}),
      spaceId,
      status: wanted.status ?? 'active',
      ...(wanted.name !== undefined ? { name: wanted.name } : {}),
      ...(wanted.location !== undefined ? { location: wanted.location } : {}),
      ...(wanted.url !== undefined ? { url: wanted.url } : {}),
      ...(wanted.tokenHash !== undefined ? { tokenHash: wanted.tokenHash } : {}),
      ...(wanted.dbRole !== undefined ? { dbRole: wanted.dbRole } : {}),
      ...(wanted.maxConcurrentSessions !== undefined ? { maxConcurrentSessions: wanted.maxConcurrentSessions } : {}),
      ...(wanted.sessionMemoryLimitMb !== undefined ? { sessionMemoryLimitMb: wanted.sessionMemoryLimitMb } : {}),
    })
    .where(and(eq(environments.isDefault, true), isNull(environments.spaceId)))
    .returning({ id: environments.id });
  const environmentId =
    unassigned?.id ?? (await seedEnvironment(db, { ...options.environment, spaceId, isDefault: true, configSource: 'env' }));
  return { userId: account.id, email: account.email, spaceId, environmentId };
}

/**
 * Another account (`member` unless `role` says otherwise) with its personal space and, unless
 * `environment: false`, its own server (`config_source = 'db'`, `active`).
 */
export async function seedMember(
  db: DbOrTx,
  options: SeedAccountOptions & {
    role?: Exclude<InstanceRole, 'owner'>;
    environment?: false | Partial<Omit<SeedEnvironmentOptions, 'spaceId' | 'isDefault'>>;
  } = {},
): Promise<SeededAccount> {
  const account = await insertUser(db, options.role ?? 'member', options);
  const spaceId = await seedSpace(db, { userId: account.id, name: options.spaceName });
  const environmentId =
    options.environment === false ? null : await seedEnvironment(db, { ...options.environment, spaceId, isDefault: false });
  return { userId: account.id, email: account.email, spaceId, environmentId };
}
