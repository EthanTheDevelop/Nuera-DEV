/**
 * Test-only fixtures of the multi-account model (docs/MULTICOMPTE.md §5), on the app database
 * (`@/server/db`, i.e. DATABASE_URL set by a `prepare…Database()` helper).
 *
 *   await resetTables();                         // every per-lot helper seeds the legacy owner:
 *   //   user TEST_USER_ID (owner) · space TEST_SPACE_ID · default server TEST_ENVIRONMENT_ID
 *   //   (« VPS-3 », config_source 'env' → RUNNER_URL / RUNNER_TOKEN, active)
 *   await db.insert(projects).values({ …, spaceId: TEST_SPACE_ID, environmentId: TEST_ENVIRONMENT_ID });
 *
 *   const b = await createTestAccount({ role: 'member' });   // own space + own server ('db' source)
 *   await scopeOfProject(b.ctx, projectOfA.id);               // → NOT_FOUND
 *
 *   await truncateTenancy();                      // empty database (no account at all)
 *   const { a, b } = await twoSpaces();           // owner on the default server + member on its own
 *
 * Servers with `configSource: 'db'` store an encrypted token: call `useTestEncryptionKey()` (or set
 * APP_ENCRYPTION_KEY) first. Contexts are built in memory (same shape as `resolveContext()`).
 */
import { randomUUID } from 'node:crypto';
import {
  commandRuns,
  environments,
  operations,
  permissionRequests,
  projects,
  sessions,
  spaceMembers,
  spaceSettings,
  spaces,
  user,
  userPreferences,
  worktrees,
} from '@nuera/db/schema';
import type { EnvironmentConfigSource, EnvironmentStatus, InstanceRole } from '@nuera/db/schema';
import { uptimeServiceKey } from '@nuera/shared/runner';
import { generateRunnerToken, hashToken } from '@nuera/shared/tokens';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { CurrentUser } from '@/server/auth/session';
import { encryptRunnerToken } from '@/server/runner/config';
import type { EnvironmentRef, RequestContext, SpaceRef } from '../context';
import { personalSpaceName } from '../names';

/** Fixed ids of the legacy single owner seeded by every per-lot test database helper. */
export const TEST_SPACE_ID = '5a1e5a1e-0000-4000-8000-00000000000a';
export const TEST_ENVIRONMENT_ID = 'e0e0e0e0-0000-4000-8000-00000000000a';

/** Unreachable runner URL (discard port): a call fails fast with RUNNER_UNAVAILABLE. */
export const UNREACHABLE_RUNNER_URL = 'http://127.0.0.1:9';

async function appDb() {
  return (await import('@/server/db')).db;
}

export interface TestEnvironment {
  id: string;
  name: string;
  /** Clear token (null for an 'env' server without RUNNER_TOKEN). */
  token: string | null;
  ref: EnvironmentRef;
}

export interface CreateTestEnvironmentOptions {
  /** null = not assigned to a space. */
  spaceId: string | null;
  id?: string;
  /** Default `db` (url + encrypted token); `env` = RUNNER_URL / RUNNER_TOKEN (the default server). */
  configSource?: EnvironmentConfigSource;
  /** Default: RUNNER_TOKEN for `env`, a fresh `nrt_…` token for `db`. */
  token?: string | null;
  /** `db` servers only; default {@link UNREACHABLE_RUNNER_URL}. */
  url?: string | null;
  /** Token being rotated in (`next_token_*`), `db` servers only. */
  nextToken?: string | null;
  /** Default « VPS-3 » for the default server, « Serveur de test » otherwise. */
  name?: string;
  location?: string | null;
  /** Default `active` when assigned, `pending` otherwise. */
  status?: EnvironmentStatus;
  /** Default: true for `env`. */
  isDefault?: boolean;
  maxConcurrentSessions?: number;
}

function environmentRef(row: { id: string; name: string; location: string | null; status: EnvironmentStatus; isDefault: boolean; maxConcurrentSessions: number }): EnvironmentRef {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    status: row.status,
    isDefault: row.isDefault,
    uptimeKey: uptimeServiceKey({ id: row.id, isDefault: row.isDefault }),
    maxConcurrentSessions: row.maxConcurrentSessions,
    primary: true,
    accounts: 1,
  };
}

/** One server row (token hashed, and encrypted for a `db` server). */
export async function createTestEnvironment(options: CreateTestEnvironmentOptions): Promise<TestEnvironment> {
  const db = await appDb();
  const id = options.id ?? randomUUID();
  const configSource = options.configSource ?? 'db';
  const isDefault = options.isDefault ?? configSource === 'env';
  const token =
    options.token !== undefined
      ? options.token
      : configSource === 'env'
        ? (process.env.RUNNER_TOKEN?.trim() || null)
        : generateRunnerToken();
  const name = options.name ?? (isDefault ? 'VPS-3' : 'Serveur de test');
  const status = options.status ?? (options.spaceId ? 'active' : 'pending');
  const maxConcurrentSessions = options.maxConcurrentSessions ?? 4;
  if (isDefault) {
    // The migration leaves an unassigned default server: replace it (only one default server).
    await db.delete(environments).where(and(eq(environments.isDefault, true), isNull(environments.spaceId)));
  }
  await db.insert(environments).values({
    id,
    spaceId: options.spaceId,
    name,
    location: options.location ?? null,
    status,
    configSource,
    isDefault,
    url: configSource === 'db' ? (options.url !== undefined ? options.url : UNREACHABLE_RUNNER_URL) : null,
    tokenEncrypted: configSource === 'db' && token ? encryptRunnerToken(id, token) : null,
    tokenHash: token ? hashToken(token) : null,
    nextTokenEncrypted: configSource === 'db' && options.nextToken ? encryptRunnerToken(id, options.nextToken) : null,
    nextTokenHash: options.nextToken ? hashToken(options.nextToken) : null,
    maxConcurrentSessions,
  });
  resetTenancyCaches();
  return {
    id,
    name,
    token,
    ref: environmentRef({ id, name, location: options.location ?? null, status, isDefault, maxConcurrentSessions }),
  };
}

/** Personal space of `userId` with its owner membership, settings and the account's preferences. */
export async function createTestSpace(options: { userId: string; name?: string; id?: string }): Promise<SpaceRef> {
  const db = await appDb();
  const [owner] = await db.select({ name: user.name }).from(user).where(eq(user.id, options.userId)).limit(1);
  const name = options.name ?? personalSpaceName(owner?.name ?? '');
  const [row] = await db
    .insert(spaces)
    .values({ ...(options.id ? { id: options.id } : {}), name, kind: 'personal', ownerUserId: options.userId })
    .returning({ id: spaces.id });
  await db.insert(spaceMembers).values({ spaceId: row!.id, userId: options.userId, role: 'owner' });
  await db.insert(spaceSettings).values({ spaceId: row!.id });
  await db.insert(userPreferences).values({ userId: options.userId }).onConflictDoNothing();
  return { id: row!.id, name, kind: 'personal', role: 'owner' };
}

export interface TestAccount {
  user: CurrentUser;
  space: SpaceRef;
  environment: EnvironmentRef | null;
  /** Clear runner token of the account's server (what its runner presents to /api/internal/*). */
  token: string | null;
  /** Request context of the account (as `resolveContext()` returns it). */
  ctx: RequestContext;
}

export interface CreateTestAccountOptions {
  id?: string;
  /** Default `member`. Only one `owner` may exist. */
  role?: InstanceRole;
  name?: string;
  email?: string;
  /** Default true (2FA is mandatory). */
  twoFactorEnabled?: boolean;
  spaceId?: string;
  spaceName?: string;
  /**
   * Server of the account's space: `false` for none. Default: the default server (`env`) for the
   * owner, an own `db` server otherwise.
   */
  environment?: false | Omit<CreateTestEnvironmentOptions, 'spaceId'>;
}

/** In-memory CurrentUser of a seeded account. */
export function testUser(input: { id: string; name: string; email: string; role: InstanceRole; twoFactorEnabled?: boolean }): CurrentUser {
  return {
    id: input.id,
    name: input.name,
    email: input.email,
    image: null,
    twoFactorEnabled: input.twoFactorEnabled ?? true,
    authSessionId: `test-session-${input.id}`,
    role: input.role,
    disabledAt: null,
  };
}

/** An account with its personal space and (unless `environment: false`) its server. */
export async function createTestAccount(options: CreateTestAccountOptions = {}): Promise<TestAccount> {
  const db = await appDb();
  const id = options.id ?? `user_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const role = options.role ?? 'member';
  const name = options.name ?? 'Compte de test';
  const email = (options.email ?? `${id}@example.test`).toLowerCase();
  await db.insert(user).values({ id, name, email, role, twoFactorEnabled: options.twoFactorEnabled ?? true });
  const space = await createTestSpace({ userId: id, name: options.spaceName, id: options.spaceId });
  let environment: TestEnvironment | null = null;
  if (options.environment !== false) {
    const defaults: Omit<CreateTestEnvironmentOptions, 'spaceId'> = role === 'owner' ? { configSource: 'env', isDefault: true } : { configSource: 'db' };
    environment = await createTestEnvironment({ ...defaults, ...(options.environment ?? {}), spaceId: space.id });
  }
  const current = testUser({ id, name, email, role, twoFactorEnabled: options.twoFactorEnabled });
  return {
    user: current,
    space,
    environment: environment?.ref ?? null,
    token: environment?.token ?? null,
    ctx: { user: current, space, environment: environment?.ref ?? null },
  };
}

/**
 * The legacy single owner of the per-lot helpers: fixed ids {@link TEST_SPACE_ID} /
 * {@link TEST_ENVIRONMENT_ID}, default server « VPS-3 » (`env`: RUNNER_URL / RUNNER_TOKEN).
 */
export async function seedLegacyOwner(input: { id: string; name: string; email: string }): Promise<TestAccount> {
  await invalidateSettings();
  return createTestAccount({
    id: input.id,
    name: input.name,
    email: input.email,
    role: 'owner',
    spaceId: TEST_SPACE_ID,
    environment: { id: TEST_ENVIRONMENT_ID, configSource: 'env', isDefault: true, name: 'VPS-3' },
  });
}

/** Context of the legacy owner, without a database round trip. */
export function legacyOwnerContext(input: { id: string; name: string; email: string }): RequestContext {
  const current = testUser({ ...input, role: 'owner' });
  return {
    user: current,
    space: { id: TEST_SPACE_ID, name: personalSpaceName(input.name), kind: 'personal', role: 'owner' },
    environment: environmentRef({ id: TEST_ENVIRONMENT_ID, name: 'VPS-3', location: null, status: 'active', isDefault: true, maxConcurrentSessions: 4 }),
  };
}

/**
 * Two isolated accounts on an EMPTY database ({@link truncateTenancy} first): `a` = the owner on
 * the default server (`env`, token = RUNNER_TOKEN), `b` = a member on its own server (`db`,
 * `nrt_…` token, URL `urlB`).
 */
export async function twoSpaces(options: { urlB?: string; nameA?: string; nameB?: string } = {}): Promise<{ a: TestAccount; b: TestAccount }> {
  const a = await createTestAccount({ role: 'owner', name: options.nameA ?? 'Ethan Martin', email: 'ethan@example.test' });
  const b = await createTestAccount({
    role: 'member',
    name: options.nameB ?? 'Camille Laurent',
    email: 'camille@example.test',
    environment: { configSource: 'db', name: 'VPS-4', url: options.urlB ?? UNREACHABLE_RUNNER_URL },
  });
  return { a, b };
}

/** Empties every account and what hangs below it (spaces, servers, projects…), plus the journal. */
export async function truncateTenancy(): Promise<void> {
  const db = await appDb();
  await db.execute(sql.raw('truncate table "user", audit_log, uptime_daily restart identity cascade'));
  resetTenancyCaches();
  await invalidateSettings();
}

/** The settings caches (instance, space, server, user) follow a truncated database. */
async function invalidateSettings(): Promise<void> {
  const settings = await import('@/server/settings');
  settings.invalidateSettingsCache();
}

/** Clears the per-process caches of the tenancy and runner modules (context, endpoints, verdicts). */
export function resetTenancyCaches(): void {
  const holder = globalThis as Record<string, unknown>;
  for (const key of ['__nueraContextCache', '__nueraRunnerEndpoints', '__nueraRunnerContracts', '__nueraTerminalVerdicts']) {
    const cache = holder[key];
    if (cache instanceof Map) cache.clear();
  }
}

export interface TestResources {
  projectId: string;
  worktreeId: string;
  sessionId: string;
  permissionId: string;
  runId: string;
  /** Operation of the project (clone). */
  operationId: string;
  /** Operation without project (integration check) on the same server. */
  serverOperationId: string;
}

/**
 * One of each runtime resource in the space and on the server of `account` (ready project,
 * session worktree, live session with a pending permission, finished run, clone operation, and an
 * operation without project). `slug` keeps paths unique when several accounts share a database.
 */
export async function createTestResources(account: Pick<TestAccount, 'space' | 'environment' | 'user'>, slug = 'nuera-os'): Promise<TestResources> {
  if (!account.environment) throw new Error("createTestResources : ce compte n'a pas de serveur.");
  const db = await appDb();
  const environmentId = account.environment.id;
  const [project] = await db
    .insert(projects)
    .values({
      spaceId: account.space.id,
      environmentId,
      createdByUserId: account.user.id,
      slug,
      name: `Projet ${slug}`,
      githubFullName: `nuera-studio/${slug}`,
      cloneUrl: `https://github.com/nuera-studio/${slug}.git`,
      path: `/srv/dev/${slug}`,
      status: 'ready',
    })
    .returning({ id: projects.id });
  const projectId = project!.id;
  const [worktree] = await db
    .insert(worktrees)
    .values({ projectId, environmentId, name: 'crm-core', branch: 'feat/crm-core', path: `/srv/dev/${slug}-worktrees/crm-core` })
    .returning({ id: worktrees.id });
  const sessionId = randomUUID();
  await db.insert(sessions).values({ id: sessionId, projectId, environmentId, worktreeId: worktree!.id, title: 'Module CRM', status: 'waiting_permission' });
  const [permission] = await db
    .insert(permissionRequests)
    .values({ sessionId, toolName: 'Bash', toolInput: { command: 'npm test' }, title: 'Claude demande à exécuter une commande' })
    .returning({ id: permissionRequests.id });
  const [run] = await db
    .insert(commandRuns)
    .values({ projectId, environmentId, worktreeId: worktree!.id, kind: 'test', command: 'npm test', status: 'succeeded', actorUserId: account.user.id })
    .returning({ id: commandRuns.id });
  const [operation] = await db
    .insert(operations)
    .values({ kind: 'clone', projectId, environmentId, status: 'succeeded' })
    .returning({ id: operations.id });
  const [serverOperation] = await db
    .insert(operations)
    .values({ kind: 'integration_check', environmentId, status: 'succeeded' })
    .returning({ id: operations.id });
  return {
    projectId,
    worktreeId: worktree!.id,
    sessionId,
    permissionId: permission!.id,
    runId: run!.id,
    operationId: operation!.id,
    serverOperationId: serverOperation!.id,
  };
}
