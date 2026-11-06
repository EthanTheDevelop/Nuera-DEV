import { account, auditLog, environments, mcpServers, notifications, projects, spaces, user } from '@nuera/db/schema';
import { hashToken } from '@nuera/shared/tokens';
import { eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/server/auth/session';
import { closeWebTestDb, dropWebTestDatabase, prepareWebTestDatabase, useTestEncryptionKey } from '@/server/tenancy/test/db';
import { startFakeRunner, type FakeRunner } from '@/server/tenancy/test/fake-runner';
import { createTestAccount, createTestResources, truncateTenancy, twoSpaces, UNREACHABLE_RUNNER_URL, type TestAccount } from '@/server/tenancy/test/fixtures';

/*
 * Administration (docs/MULTICOMPTE.md §6, §10, §11) against a real database: server registration
 * (restricted PostgreSQL role, DSN, token shown once), « Vérifier » against a fake runner, token
 * rotation and promotion, assignment, retirement, suspension refusing the runner's internal callbacks,
 * deletion, instance settings and journal, and the routes /api/admin/** refusing members (403, same
 * answer whatever the id) and answering an unknown id like a malformed one (404).
 */

const APP_URL = 'http://localhost:3105';
const RUNNER_TOKEN = 'runner-token-for-admin-tests-0123456789';
const ADMIN_URL = process.env.NUERA_TEST_PG_ADMIN_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/postgres';
const DATABASE = 'nuera_x3_admin';

const state = vi.hoisted(() => ({ current: null as CurrentUser | null }));

vi.mock('@/server/auth/session', async () => {
  const { AppError } = await import('@/server/errors');
  const isInstanceAdmin = (u: Pick<CurrentUser, 'role'>) => u.role === 'owner' || u.role === 'admin';
  return {
    getCurrentUser: async () => state.current,
    requireUser: async () => {
      if (!state.current) throw new Error('NEXT_REDIRECT /connexion');
      return state.current;
    },
    requireUserForApi: async () => {
      if (!state.current) throw new AppError('UNAUTHORIZED');
      return state.current;
    },
    isInstanceAdmin,
  };
});

const admin = await import('./index');
const { db } = await import('@/server/db');
const { rateLimiter } = await import('@/server/security/rate-limit');

const createdRoles = new Set<string>();
let a: TestAccount;
let b: TestAccount;
let runner: FakeRunner;

function actorOf(target: TestAccount) {
  return { id: target.user.id, name: target.user.name, email: target.user.email, role: target.user.role };
}

const OWNER_PASSWORD = 'Riviere-Bleue-2026!';

/** A credential row (scrypt hash of Better Auth) so that the account can re-enter its password. */
async function givePassword(target: TestAccount, password = OWNER_PASSWORD): Promise<void> {
  const { getAuthContext } = await import('@/server/auth/auth');
  const hash = await (await getAuthContext()).password.hash(password);
  await db.insert(account).values({ id: crypto.randomUUID(), accountId: target.user.id, providerId: 'credential', userId: target.user.id, password: hash });
}

function healthBody(environment: { id: string; name: string } | null, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    service: 'runner',
    version: '1.4.0',
    startedAt: '2026-11-05T10:00:00.000Z',
    uptimeSec: 12,
    backend: 'pty',
    git: { available: true, version: '2.47.0', error: null },
    tmux: { available: false, version: null, error: null },
    claude: { available: true, version: '2.1.0', error: null },
    database: { ok: true, error: null },
    disk: null,
    projectsRoot: '/srv/dev',
    dataDir: '/data',
    environment,
    state: 'ready',
    contractVersion: 2,
    ...overrides,
  };
}

type Handler = (request: NextRequest, context: { params: Promise<unknown> }) => Promise<Response>;

async function call(handler: Handler, method: string, path: string, params: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: unknown }> {
  const request = new NextRequest(`${APP_URL}${path}`, {
    method,
    headers: { origin: APP_URL, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await handler(request, { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

async function pg<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  await prepareWebTestDatabase(DATABASE);
  useTestEncryptionKey();
  process.env.APP_URL = APP_URL;
  process.env.NUERA_RATE_LIMIT_FACTOR = '50';
  runner = await startFakeRunner();
});

afterAll(async () => {
  await runner.close();
  await closeWebTestDb();
  await dropWebTestDatabase(DATABASE);
  // Roles are cluster-wide: drop the ones this suite created.
  await pg(async (sql) => {
    for (const role of createdRoles) await sql.unsafe(`drop role if exists "${role}"`);
  });
}, 60_000);

beforeEach(async () => {
  vi.stubEnv('RUNNER_TOKEN', RUNNER_TOKEN);
  vi.stubEnv('NUERA_RUNNER_HOSTS', '');
  rateLimiter.reset();
  runner.requests.length = 0;
  runner.handle((_req, res) => runner.json(res, 404, { error: { code: 'NOT_FOUND', message: 'Route inconnue.' } }));
  await truncateTenancy();
  ({ a, b } = await twoSpaces());
  state.current = a.user;
});

describe('serveurs · enregistrement', () => {
  it('crée la ligne en attente, le jeton (affiché une fois) et un rôle PostgreSQL restreint avec son DSN', async () => {
    const registered = await admin.registerServer(actorOf(a), { name: 'VPS-5', url: `${runner.url}/`, location: 'Paris' });
    createdRoles.add(registered.dbRole);
    expect(registered.token).toMatch(/^nrt_[A-Za-z0-9_-]{43}$/);
    expect(registered.dbRole).toMatch(/^nuera_env_[0-9a-f]{8}$/);
    const [row] = await db.select().from(environments).where(eq(environments.id, registered.id));
    expect(row).toMatchObject({ name: 'VPS-5', location: 'Paris', status: 'pending', spaceId: null, configSource: 'db', isDefault: false, url: runner.url, tokenHash: hashToken(registered.token), dbRole: registered.dbRole });
    expect(JSON.stringify(row)).not.toContain(registered.token);

    const dsn = new URL(registered.databaseUrl);
    const base = new URL(process.env.DATABASE_URL!);
    expect([dsn.username, dsn.host, dsn.pathname]).toEqual([registered.dbRole, base.host, base.pathname]);
    // The role logs in, is a member of nuera_runner, and sees itself as this server (row-level security).
    const restricted = postgres(registered.databaseUrl, { max: 1, onnotice: () => {} });
    try {
      const [identity] = await restricted`select nuera_runner_environment_id() as id`;
      expect(identity!.id).toBe(registered.id);
      await expect(restricted`select count(*) from "user"`).rejects.toThrow();
    } finally {
      await restricted.end({ timeout: 5 });
    }

    const listed = await admin.listServers(actorOf(a));
    expect(JSON.stringify(listed)).not.toContain(registered.token);
    expect(listed.find((item) => item.id === registered.id)).toMatchObject({ status: 'pending', account: null, hasDatabaseRole: true });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'admin.server_registered'))).toEqual([
      expect.objectContaining({ actorUserId: a.user.id, targetId: registered.id }),
    ]);
  });

  it("refuse une adresse invalide, avec identifiants, ou hors NUERA_RUNNER_HOSTS, sans rien créer", async () => {
    for (const url of ['ftp://runner:4100', 'http://user:secret@runner:4100', 'pas une adresse', 'http://runner:4100/?x=1']) {
      await expect(admin.registerServer(actorOf(a), { name: 'VPS-X', url })).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    vi.stubEnv('NUERA_RUNNER_HOSTS', 'runner-vps-4, runner-vps-5:4100');
    await expect(admin.registerServer(actorOf(a), { name: 'VPS-X', url: 'http://10.0.0.8:4100' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(admin.normaliseRunnerUrl('http://runner-vps-4:4100/')).toBe('http://runner-vps-4:4100');
    expect(admin.normaliseRunnerUrl('http://runner-vps-5:4100')).toBe('http://runner-vps-5:4100');
    expect(await db.select().from(environments).where(eq(environments.name, 'VPS-X'))).toHaveLength(0);
    await expect(admin.registerServer(actorOf(b), { name: 'VPS-X', url: 'http://runner:4100' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('serveurs · vérifier, renouveler le jeton, attribuer, retirer', () => {
  it('« Vérifier » : même serveur, état prêt, contrat ; injoignable ; mauvais serveur', async () => {
    const registered = await admin.registerServer(actorOf(a), { name: 'VPS-5', url: runner.url });
    createdRoles.add(registered.dbRole);
    runner.handle((_req, res) => runner.json(res, 200, healthBody({ id: registered.id, name: 'VPS-5' })));
    const ok = await admin.verifyServer(actorOf(a), registered.id);
    expect(ok).toMatchObject({ ok: true, message: 'VPS-5 répond · runner 1.4.0', problems: [], contractVersion: 2 });
    expect(runner.requests.at(-1)).toMatchObject({ method: 'GET', path: '/v1/health', authorization: `Bearer ${registered.token}` });

    runner.handle((_req, res) => runner.json(res, 200, healthBody({ id: crypto.randomUUID(), name: 'VPS-9' }, { contractVersion: 1 })));
    const wrong = await admin.verifyServer(actorOf(a), registered.id);
    expect(wrong.ok).toBe(false);
    expect(wrong.problems.join(' ')).toMatch(/autre serveur \(VPS-9\)/);
    expect(wrong.problems.join(' ')).toMatch(/Contrat du runner 1/);

    await db.update(environments).set({ url: UNREACHABLE_RUNNER_URL }).where(eq(environments.id, registered.id));
    const down = await admin.verifyServer(actorOf(a), registered.id);
    expect(down).toMatchObject({ ok: false, message: 'VPS-5 ne répond pas : le runner est injoignable.' });
  });

  it("renouvelle le jeton : les deux marchent, puis le premier appel avec le nouveau l'installe et l'ancien est refusé", async () => {
    const oldToken = b.token!;
    runner.handle((req, res) =>
      req.headers.authorization === `Bearer ${oldToken}` ? runner.json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Jeton refusé.' } }) : runner.json(res, 200, healthBody({ id: b.environment!.id, name: 'VPS-4' })),
    );
    await db.update(environments).set({ url: runner.url }).where(eq(environments.id, b.environment!.id));
    const rotated = await admin.rotateServerToken(actorOf(a), b.environment!.id);
    expect(rotated.token).toMatch(/^nrt_/);
    const [pending] = await db.select().from(environments).where(eq(environments.id, b.environment!.id));
    expect([pending!.tokenHash, pending!.nextTokenHash]).toEqual([hashToken(oldToken), hashToken(rotated.token)]);

    const { resolveRunnerCaller } = await import('@/server/security/runner-token');
    expect(await resolveRunnerCaller(`Bearer ${oldToken}`)).toMatchObject({ id: b.environment!.id });
    const verified = await admin.verifyServer(actorOf(a), b.environment!.id);
    expect(verified).toMatchObject({ ok: true, tokenPromoted: true });
    const [promoted] = await db.select().from(environments).where(eq(environments.id, b.environment!.id));
    expect([promoted!.tokenHash, promoted!.nextTokenHash]).toEqual([hashToken(rotated.token), null]);
    expect(await resolveRunnerCaller(`Bearer ${oldToken}`)).toBeNull();
    expect(await resolveRunnerCaller(`Bearer ${rotated.token}`)).toMatchObject({ id: b.environment!.id });
    // The default server's token is RUNNER_TOKEN: never rotated here.
    await expect(admin.rotateServerToken(actorOf(a), a.environment!.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it("attribue un serveur jamais utilisé à un compte sans serveur ; jamais deux fois ; retrait refusé tant qu'un projet actif y vit", async () => {
    const registered = await admin.registerServer(actorOf(a), { name: 'VPS-6', url: runner.url });
    createdRoles.add(registered.dbRole);
    await expect(admin.assignServer(actorOf(a), registered.id, { userId: b.user.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    const c = await createTestAccount({ name: 'Nadia Lefèvre', email: 'nadia@example.test', environment: false });
    // Promised to an invitation in progress: it goes to the person invited, not to another account.
    const promise = await admin.createInvitation(actorOf(a), { email: 'invitee@example.test', environmentId: registered.id });
    await expect(admin.assignServer(actorOf(a), registered.id, { userId: c.user.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: "Ce serveur est promis à l'invitation adressée à invitee@example.test : annulez-la d'abord.",
    });
    await admin.revokeInvitation(actorOf(a), promise.id);
    const assigned = await admin.assignServer(actorOf(a), registered.id, { userId: c.user.id });
    expect(assigned).toMatchObject({ status: 'active', account: { id: c.user.id } });
    const [row] = await db.select({ spaceId: environments.spaceId }).from(environments).where(eq(environments.id, registered.id));
    expect(row!.spaceId).toBe(c.space.id);
    // A server already used is never reassigned.
    const d = await createTestAccount({ name: 'Yanis Bernard', email: 'yanis@example.test', environment: false });
    await expect(admin.assignServer(actorOf(a), registered.id, { userId: d.user.id })).rejects.toMatchObject({ code: 'CONFLICT' });

    await createTestResources(
      { space: c.space, user: c.user, environment: { id: registered.id, name: 'VPS-6', location: null, status: 'active', isDefault: false, uptimeKey: `runner:${registered.id}`, maxConcurrentSessions: 4 } },
      'projet-c',
    );
    await expect(admin.retireServer(actorOf(a), registered.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.environmentId, registered.id));
    expect(await admin.retireServer(actorOf(a), registered.id)).toMatchObject({ status: 'retired' });
    const [login] = await pg((sql) => sql`select rolcanlogin from pg_roles where rolname = ${registered.dbRole}`);
    expect(login!.rolcanlogin).toBe(false);
    await expect(admin.retireServer(actorOf(a), a.environment!.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it("remet « à tester » l'état Claude Code des serveurs MCP de l'espace et oublie les hôtes internes quand son serveur change", async () => {
    const ssrf = globalThis as unknown as { __nueraSsrfInternal?: unknown };
    const primeSsrf = () => {
      ssrf.__nueraSsrfInternal = { names: new Set<string>(), addresses: new Set<string>(), at: Date.now() };
    };
    const c = await createTestAccount({ name: 'Nadia Lefèvre', email: 'nadia@example.test', environment: false });
    const synced = { status: 'connected' as const, syncedToCliAt: new Date(), lastError: 'ancienne erreur' };
    const rows = await db
      .insert(mcpServers)
      .values([
        { spaceId: c.space.id, name: 'playwright', label: 'Playwright', transport: 'stdio', command: 'npx', ...synced },
        { spaceId: c.space.id, name: 'figma', label: 'Figma', transport: 'http', url: 'https://mcp.figma.com/mcp', authKind: 'oauth', ...synced },
        { spaceId: c.space.id, name: 'outil', label: 'Outil', transport: 'http', url: 'https://outil.example.test/mcp', authKind: 'bearer', ...synced },
        { spaceId: b.space.id, name: 'playwright', label: 'Playwright', transport: 'stdio', command: 'npx', ...synced },
      ])
      .returning({ id: mcpServers.id, spaceId: mcpServers.spaceId, name: mcpServers.name });
    const states = async () =>
      Object.fromEntries(
        (await db.select().from(mcpServers).where(inArray(mcpServers.id, rows.map((row) => row.id)))).map((row) => [
          `${row.spaceId === c.space.id ? 'c' : 'b'}:${row.name}`,
          row.status === 'unknown' && row.syncedToCliAt === null && row.lastError === null ? 'à tester' : row.status,
        ]),
      );
    const resync = () => db.update(mcpServers).set(synced).where(inArray(mcpServers.id, rows.map((row) => row.id)));
    const resetOfC = { 'c:playwright': 'à tester', 'c:figma': 'à tester', 'c:outil': 'connected', 'b:playwright': 'connected' };
    const untouched = { 'c:playwright': 'connected', 'c:figma': 'connected', 'c:outil': 'connected', 'b:playwright': 'connected' };

    primeSsrf();
    const registered = await admin.registerServer(actorOf(a), { name: 'VPS-7', url: runner.url });
    createdRoles.add(registered.dbRole);
    expect(ssrf.__nueraSsrfInternal).toBeNull();
    expect(await states()).toEqual(untouched);

    await admin.assignServer(actorOf(a), registered.id, { userId: c.user.id });
    expect(await states()).toEqual(resetOfC);

    await resync();
    await admin.rotateServerToken(actorOf(a), registered.id);
    expect(await states()).toEqual(resetOfC);

    // Same address (normalised): nothing to forget. Another address: guard list and CLI state follow.
    await resync();
    primeSsrf();
    await admin.updateServer(actorOf(a), registered.id, { url: `${runner.url}/`, maxConcurrentSessionsCap: 6 });
    expect(ssrf.__nueraSsrfInternal).not.toBeNull();
    expect(await states()).toEqual(untouched);
    await givePassword(a);
    await admin.updateServer(actorOf(a), registered.id, { url: 'http://runner-vps-7:4100', password: OWNER_PASSWORD });
    expect(ssrf.__nueraSsrfInternal).toBeNull();
    expect(await states()).toEqual(resetOfC);
    expect((await admin.getServer(actorOf(a), registered.id)).url).toBe('http://runner-vps-7:4100');

    await resync();
    await admin.retireServer(actorOf(a), registered.id);
    expect(await states()).toEqual(resetOfC);
  });
});

describe('comptes · désactivation, suppression', () => {
  it("désactiver suspend le serveur : ses rappels internes sont refusés, ses sessions Claude sont arrêtées par SON runner", async () => {
    await db.update(environments).set({ url: runner.url }).where(eq(environments.id, b.environment!.id));
    const resources = await createTestResources(b, 'projet-b');
    // The fake runner answers the stop with an empty body: the call is counted, as sent to B's runner only.
    runner.handle((_req, res) => runner.json(res, 200, {}));
    const result = await admin.disableAccount(actorOf(a), b.user.id, { stopSessions: true });
    expect(result.server).toMatchObject({ id: b.environment!.id, name: 'VPS-4' });
    expect(runner.requests.map((request) => `${request.method} ${request.path}`)).toEqual([`POST /v1/sessions/${resources.sessionId}/stop`]);
    expect(result.stoppedSessions + result.failedSessions).toBe(1);
    const [suspended] = await db.select({ status: environments.status }).from(environments).where(eq(environments.id, b.environment!.id));
    expect(suspended!.status).toBe('suspended');

    const notify = (await import('@/app/api/internal/notify/route')).POST as Handler;
    const refused = await notify(
      new NextRequest(`${APP_URL}/api/internal/notify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'server', title: 'x' }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: 'FORBIDDEN', message: 'Ce serveur est suspendu.' } });

    await admin.enableAccount(actorOf(a), b.user.id);
    const [active] = await db.select({ status: environments.status }).from(environments).where(eq(environments.id, b.environment!.id));
    expect(active!.status).toBe('active');
  });

  it("supprimer : seulement un compte désactivé ; anonymisé, espace archivé, serveur retiré, journal gardé", async () => {
    await expect(admin.deleteAccount(actorOf(a), b.user.id)).rejects.toMatchObject({ code: 'CONFLICT', message: "Désactivez d'abord le compte." });
    await db.update(environments).set({ url: runner.url }).where(eq(environments.id, b.environment!.id));
    const resources = await createTestResources(b, 'projet-b');
    runner.handle((_req, res) => runner.json(res, 200, {}));
    await admin.disableAccount(actorOf(a), b.user.id, { stopSessions: false });
    expect(runner.requests).toHaveLength(0);
    // Disabled without « Arrêter aussi… »: its sessions still running are stopped by ITS runner on deletion.
    const deleted = await admin.deleteAccount(actorOf(a), b.user.id);
    expect(runner.requests.map((request) => `${request.method} ${request.path}`)).toEqual([`POST /v1/sessions/${resources.sessionId}/stop`]);
    expect(deleted).toMatchObject({ id: b.user.id, email: 'camille@example.test' });
    expect(deleted.stoppedSessions + deleted.failedSessions).toBe(1);
    const [row] = await db.select().from(user).where(eq(user.id, b.user.id));
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.email).not.toContain('camille');
    const [space] = await db.select({ archivedAt: spaces.archivedAt }).from(spaces).where(eq(spaces.id, b.space.id));
    expect(space!.archivedAt).not.toBeNull();
    const [server] = await db.select({ status: environments.status }).from(environments).where(eq(environments.id, b.environment!.id));
    expect(server!.status).toBe('retired');
    expect((await admin.listAccounts(actorOf(a))).map((item) => item.id)).toEqual([a.user.id]);
    await expect(admin.getAccount(actorOf(a), b.user.id)).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Compte introuvable.' });
    const [journal] = await db.select().from(auditLog).where(eq(auditLog.action, 'admin.account_deleted'));
    expect(journal).toMatchObject({ actorUserId: a.user.id, actorLabel: 'ethan@example.test', subjectUserId: b.user.id });
  });

  it("la liste des comptes ne montre ni IP ni identité Claude, et chaque compte avec son espace et son serveur", async () => {
    const accounts = await admin.listAccounts(actorOf(a));
    expect(accounts).toEqual([
      expect.objectContaining({ id: a.user.id, role: 'owner', isSelf: true, server: expect.objectContaining({ name: 'VPS-3' }) }),
      expect.objectContaining({ id: b.user.id, role: 'member', isSelf: false, server: expect.objectContaining({ name: 'VPS-4' }), space: expect.objectContaining({ id: b.space.id }) }),
    ]);
    const text = JSON.stringify(accounts);
    expect(text).not.toMatch(/"ip"|ipAddress|organization|claudeEmail/);
  });
});

describe("serveurs · adresse interne d'un serveur en service", () => {
  const NEW_URL = 'http://runner-vps-9:4100';
  const serverRow = async (id: string) => (await db.select().from(environments).where(eq(environments.id, id)))[0]!;
  const notificationsOf = (userId: string) => db.select().from(notifications).where(eq(notifications.userId, userId));
  const updates = () => db.select().from(auditLog).where(eq(auditLog.action, 'admin.server_updated'));

  it("un administrateur ne change jamais l'adresse du serveur d'un autre compte : 403, rien d'écrit, rien envoyé", async () => {
    const d = await createTestAccount({ role: 'admin', name: 'Inès Moreau', email: 'ines@example.test', environment: false });
    await givePassword(d);
    const before = await serverRow(b.environment!.id);
    for (const input of [{ url: NEW_URL }, { url: NEW_URL, password: OWNER_PASSWORD }, { url: NEW_URL, name: 'Renommé' }]) {
      await expect(admin.updateServer(actorOf(d), b.environment!.id, input)).rejects.toMatchObject({ code: 'FORBIDDEN', message: admin.SERVER_ADDRESS_GUARDS.ownerOnly });
    }
    // Same answer through the route.
    state.current = d.user;
    const route = (await import('@/app/api/admin/servers/[id]/route')).PATCH as Handler;
    expect(await call(route, 'PATCH', `/api/admin/servers/${b.environment!.id}`, { id: b.environment!.id }, { url: NEW_URL, password: OWNER_PASSWORD })).toEqual({
      status: 403,
      body: { error: { code: 'FORBIDDEN', message: admin.SERVER_ADDRESS_GUARDS.ownerOnly } },
    });
    const after = await serverRow(b.environment!.id);
    expect([after.url, after.name, after.tokenHash, after.nextTokenHash]).toEqual([before.url, before.name, before.tokenHash, before.nextTokenHash]);
    expect(await updates()).toEqual([]);
    expect(await notificationsOf(b.user.id)).toEqual([]);
    expect(runner.requests).toHaveLength(0);
    // Its own server: allowed without password, never notified to anybody else.
    const e = await createTestAccount({ role: 'admin', name: 'Hugo Petit', email: 'hugo@example.test', environment: { configSource: 'db', name: 'VPS-8', url: 'http://runner-vps-8:4100' } });
    const own = await admin.updateServer(actorOf(e), e.environment!.id, { url: NEW_URL });
    expect(own.token).toMatch(/^nrt_/);
    expect((await serverRow(e.environment!.id)).tokenHash).toBe(hashToken(own.token!));
    expect(await db.select().from(notifications)).toEqual([]);
  });

  it("le propriétaire de l'instance : mot de passe exigé ; le jeton est remplacé, l'ancien n'est jamais envoyé à la nouvelle adresse ; le compte est prévenu", async () => {
    await givePassword(a);
    const oldToken = b.token!;
    const before = await serverRow(b.environment!.id);
    await expect(admin.updateServer(actorOf(a), b.environment!.id, { url: runner.url })).rejects.toMatchObject({ code: 'FORBIDDEN', message: admin.SERVER_ADDRESS_GUARDS.password });
    await expect(admin.updateServer(actorOf(a), b.environment!.id, { url: runner.url, password: 'Mauvais-Mot-2026!' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Votre mot de passe est incorrect.',
    });
    expect((await serverRow(b.environment!.id)).url).toBe(before.url);
    expect(await updates()).toEqual([]);

    // A rotation in progress is dropped too: neither the current nor the next token survives.
    const rotated = await admin.rotateServerToken(actorOf(a), b.environment!.id);
    const updated = await admin.updateServer(actorOf(a), b.environment!.id, { url: `${runner.url}/`, password: OWNER_PASSWORD });
    expect(updated.token).toMatch(/^nrt_[A-Za-z0-9_-]{43}$/);
    expect(updated.server).toMatchObject({ id: b.environment!.id, url: runner.url, rotationPending: false, ownedByOther: true });
    const after = await serverRow(b.environment!.id);
    expect([after.url, after.tokenHash, after.nextTokenHash, after.nextTokenEncrypted]).toEqual([runner.url, hashToken(updated.token!), null, null]);
    expect(JSON.stringify(after)).not.toContain(updated.token!);

    const { resolveRunnerCaller } = await import('@/server/security/runner-token');
    expect(await resolveRunnerCaller(`Bearer ${oldToken}`)).toBeNull();
    expect(await resolveRunnerCaller(`Bearer ${rotated.token}`)).toBeNull();
    expect(await resolveRunnerCaller(`Bearer ${updated.token}`)).toMatchObject({ id: b.environment!.id });

    // Every call of the web to the new address carries the new token only.
    runner.handle((_req, res) => runner.json(res, 200, healthBody({ id: b.environment!.id, name: 'VPS-4' })));
    expect(await admin.verifyServer(actorOf(a), b.environment!.id)).toMatchObject({ ok: true });
    const { getRunnerForEnvironment } = await import('@/server/runner/client');
    await (await getRunnerForEnvironment(b.environment!.id)).health().catch(() => undefined);
    expect(runner.requests.length).toBeGreaterThan(0);
    expect(new Set(runner.requests.map((request) => request.authorization))).toEqual(new Set([`Bearer ${updated.token}`]));

    // Journal: names the account (its personal journal), never a token.
    const [entry] = await updates();
    expect(entry).toMatchObject({ actorUserId: a.user.id, subjectUserId: b.user.id, environmentId: b.environment!.id });
    expect(entry!.metadata).toMatchObject({ url: runner.url, previousUrl: before.url, rotated: true });
    expect(JSON.stringify(entry)).not.toContain(updated.token!);
    const [rotation] = await db.select().from(auditLog).where(eq(auditLog.action, 'admin.server_token_rotated'));
    expect(rotation).toMatchObject({ subjectUserId: b.user.id });

    // The account is told, for the rotation and for the address.
    const received = (await notificationsOf(b.user.id)).map((row) => [row.kind, row.spaceId, row.title]);
    expect(received).toEqual(
      expect.arrayContaining([
        ['security', b.space.id, 'Un administrateur a renouvelé le jeton de votre serveur VPS-4.'],
        ['security', b.space.id, "L'adresse interne de votre serveur VPS-4 a été modifiée par un administrateur."],
      ]),
    );
    expect(await notificationsOf(a.user.id)).toEqual([]);
  });

  it("un serveur jamais utilisé garde son jeton ; deux serveurs en service ne partagent jamais une adresse", async () => {
    const registered = await admin.registerServer(actorOf(a), { name: 'VPS-5', url: 'http://runner-vps-5:4100' });
    createdRoles.add(registered.dbRole);
    const moved = await admin.updateServer(actorOf(a), registered.id, { url: 'http://runner-vps-5b:4100' });
    expect(moved.token).toBeNull();
    expect((await serverRow(registered.id)).tokenHash).toBe(hashToken(registered.token));

    const taken = 'Cette adresse est déjà celle du serveur « VPS-4 ».';
    await expect(admin.registerServer(actorOf(a), { name: 'VPS-6', url: `${UNREACHABLE_RUNNER_URL}/` })).rejects.toMatchObject({ code: 'CONFLICT', message: taken });
    await expect(admin.updateServer(actorOf(a), registered.id, { url: UNREACHABLE_RUNNER_URL })).rejects.toMatchObject({ code: 'CONFLICT', message: taken });
    // The default server's address is RUNNER_URL.
    vi.stubEnv('RUNNER_URL', 'http://runner-vps-3:4100');
    await expect(admin.registerServer(actorOf(a), { name: 'VPS-6', url: 'http://runner-vps-3:4100' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Cette adresse est déjà celle du serveur « VPS-3 ».',
    });
    expect(await db.select().from(environments).where(eq(environments.name, 'VPS-6'))).toHaveLength(0);
    // A retired server leaves its address to the one replacing it.
    await admin.retireServer(actorOf(a), registered.id);
    const replacement = await admin.registerServer(actorOf(a), { name: 'VPS-6', url: 'http://runner-vps-5b:4100' });
    createdRoles.add(replacement.dbRole);
    expect(replacement.server.url).toBe('http://runner-vps-5b:4100');
  });

  it("le serveur change pendant la vérification (autre administrateur) : rien d'écrit, aucun jeton perdu", async () => {
    await givePassword(a);
    const before = await serverRow(b.environment!.id);
    const { getAuthContext } = await import('@/server/auth/auth');
    const context = await getAuthContext();
    // While the owner's password is checked, another administrator moves the server elsewhere.
    const verify = vi.spyOn(context.password, 'verify').mockImplementationOnce(async () => {
      await db.update(environments).set({ url: 'http://runner-vps-7:4100' }).where(eq(environments.id, b.environment!.id));
      return true;
    });
    try {
      await expect(admin.updateServer(actorOf(a), b.environment!.id, { url: NEW_URL, password: OWNER_PASSWORD })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'Ce serveur vient de changer : rouvrez-le, puis réessayez.',
      });
    } finally {
      verify.mockRestore();
    }
    const after = await serverRow(b.environment!.id);
    expect([after.url, after.tokenHash, after.nextTokenHash]).toEqual(['http://runner-vps-7:4100', before.tokenHash, before.nextTokenHash]);
    expect(await updates()).toEqual([]);
    expect(await notificationsOf(b.user.id)).toEqual([]);
  });
});

describe('serveurs · rôle PostgreSQL restreint', () => {
  const roleOf = async (name: string) =>
    (await pg((sql) => sql`select rolconnlimit, rolcanlogin, coalesce(rolconfig, '{}') as rolconfig from pg_roles where rolname = ${name}`))[0]!;

  it('borne NUERA_RUNNER_DB_CONNECTION_LIMIT', async () => {
    const { runnerRoleConnectionLimit } = await import('./db-roles');
    expect(runnerRoleConnectionLimit({})).toBe(20);
    expect(runnerRoleConnectionLimit({ NUERA_RUNNER_DB_CONNECTION_LIMIT: '' })).toBe(20);
    expect(runnerRoleConnectionLimit({ NUERA_RUNNER_DB_CONNECTION_LIMIT: 'beaucoup' })).toBe(20);
    expect(runnerRoleConnectionLimit({ NUERA_RUNNER_DB_CONNECTION_LIMIT: '-3' })).toBe(20);
    expect(runnerRoleConnectionLimit({ NUERA_RUNNER_DB_CONNECTION_LIMIT: '2' })).toBe(4);
    expect(runnerRoleConnectionLimit({ NUERA_RUNNER_DB_CONNECTION_LIMIT: '12' })).toBe(12);
    expect(runnerRoleConnectionLimit({ NUERA_RUNNER_DB_CONNECTION_LIMIT: '99999' })).toBe(500);
  });

  it('plafonne les connexions du rôle et borne ses requêtes ; un nouveau mot de passe remet les limites', async () => {
    vi.stubEnv('NUERA_RUNNER_DB_CONNECTION_LIMIT', '4');
    const registered = await admin.registerServer(actorOf(a), { name: 'VPS-5', url: runner.url });
    createdRoles.add(registered.dbRole);
    const role = await roleOf(registered.dbRole);
    expect(role.rolconnlimit).toBe(4);
    expect(role.rolconfig).toEqual(expect.arrayContaining(['statement_timeout=2min', 'idle_in_transaction_session_timeout=1min']));

    const clients = Array.from({ length: 5 }, () => postgres(registered.databaseUrl, { max: 1, onnotice: () => {} }));
    try {
      for (const client of clients.slice(0, 4)) await client`select 1`;
      await expect(clients[4]!`select 1`).rejects.toThrow(/too many connections/);
      const [timeouts] = await clients[0]!`select current_setting('statement_timeout') as statement, current_setting('idle_in_transaction_session_timeout') as idle`;
      expect(timeouts).toEqual({ statement: '2min', idle: '1min' });
    } finally {
      await Promise.all(clients.map((client) => client.end({ timeout: 5 })));
    }

    // A role created before these limits (or changed by hand) gets them back with a new password.
    vi.stubEnv('NUERA_RUNNER_DB_CONNECTION_LIMIT', '');
    await pg((sql) => sql.unsafe(`alter role "${registered.dbRole}" connection limit -1`));
    await pg((sql) => sql.unsafe(`alter role "${registered.dbRole}" reset all`));
    await admin.restrictServerDatabase(actorOf(a), registered.id);
    const renewed = await roleOf(registered.dbRole);
    expect(renewed.rolconnlimit).toBe(20);
    expect(renewed.rolconfig).toEqual(expect.arrayContaining(['statement_timeout=2min', 'idle_in_transaction_session_timeout=1min']));
  });

  it("retirer le serveur ferme les connexions déjà ouvertes de son rôle ; un nouveau DSN ferme celles de l'ancien", async () => {
    const registered = await admin.registerServer(actorOf(a), { name: 'VPS-5', url: runner.url });
    createdRoles.add(registered.dbRole);
    const first = postgres(registered.databaseUrl, { max: 1, onnotice: () => {} });
    try {
      await first`select 1`;
      await admin.restrictServerDatabase(actorOf(a), registered.id);
      await expect(first`select 1`).rejects.toThrow();
    } finally {
      await first.end({ timeout: 5 });
    }
    const [renewal] = await db.select().from(auditLog).where(eq(auditLog.action, 'admin.server_database_restricted'));
    expect(renewal!.metadata).toMatchObject({ closedConnections: 1, refusedConnections: 0 });

    // A connection opened with the current password is closed by the retirement, and none opens again.
    const password = 'mot-de-passe-de-test-0123456789';
    await pg((sql) => sql.unsafe(`alter role "${registered.dbRole}" password '${password}'`));
    const dsn = new URL(registered.databaseUrl);
    dsn.password = password;
    const open = postgres(dsn.toString(), { max: 1, onnotice: () => {} });
    try {
      await open`select 1`;
      await admin.retireServer(actorOf(a), registered.id);
      await expect(open`select 1`).rejects.toThrow();
    } finally {
      await open.end({ timeout: 5 });
    }
    const [retired] = await db.select().from(auditLog).where(eq(auditLog.action, 'admin.server_retired'));
    expect(retired!.metadata).toMatchObject({ closedConnections: 1, refusedConnections: 0 });
    const late = postgres(dsn.toString(), { max: 1, onnotice: () => {} });
    try {
      await expect(late`select 1`).rejects.toThrow(/not permitted to log in/);
    } finally {
      await late.end({ timeout: 5 });
    }
  });

  it('PostgreSQL refuse de fermer une connexion : compté, jamais levé', async () => {
    const { closeRunnerRoleConnections } = await import('./db-roles');
    let calls = 0;
    const refusing = {
      execute: async () => {
        calls += 1;
        if (calls === 1) return [{ pid: 4242 }, { pid: '4243' }];
        throw new Error('permission denied to terminate process');
      },
    } as unknown as Parameters<typeof closeRunnerRoleConnections>[1];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await closeRunnerRoleConnections('nuera_env_0123abcd', refusing)).toEqual({ closed: 0, refused: 2 });
      expect(await closeRunnerRoleConnections('pas un rôle', refusing)).toEqual({ closed: 0, refused: 0 });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('instance et journal', () => {
  it("avertit tant que le serveur par défaut a toute la base ; restreindre crée son rôle et son DSN", async () => {
    expect((await admin.getInstanceView(actorOf(a))).warning).toBe('Le serveur VPS-3 accède encore à toute la base de données.');
    const access = await admin.restrictServerDatabase(actorOf(a), a.environment!.id);
    createdRoles.add(access.dbRole);
    expect(new URL(access.databaseUrl).username).toBe(access.dbRole);
    // Still warned until the runner's heartbeat reports the restricted role.
    expect((await admin.getInstanceView(actorOf(a))).warning).not.toBeNull();
    await db.update(environments).set({ capabilities: { database: { role: access.dbRole, restricted: true } } as never }).where(eq(environments.id, a.environment!.id));
    expect((await admin.getInstanceView(actorOf(a))).warning).toBeNull();
    expect((await admin.getServer(actorOf(a), a.environment!.id)).databaseRestricted).toBe(true);
  });

  it("ne croit pas le battement seul : rôle vérifié dans PostgreSQL, et aucun runner connecté avec le DSN complet", async () => {
    const access = await admin.restrictServerDatabase(actorOf(a), a.environment!.id);
    createdRoles.add(access.dbRole);
    const warning = async () => (await admin.getInstanceView(actorOf(a))).warning;
    const claim = (database: { role: string; restricted: boolean }) =>
      db.update(environments).set({ capabilities: { database } as never }).where(eq(environments.id, a.environment!.id));
    const connect = async (url: string, application: string) => {
      const client = postgres(url, { max: 1, onnotice: () => {}, connection: { application_name: application } });
      await client`select 1`;
      return client;
    };

    // A heartbeat naming another role than the recorded one, or a role that is not restricted.
    await claim({ role: 'nuera_env_ffffffff', restricted: true });
    expect(await warning()).not.toBeNull();
    const [superuser] = await pg((sql) => sql`select current_user as name`);
    await db.update(environments).set({ dbRole: superuser!.name as string }).where(eq(environments.id, a.environment!.id));
    await claim({ role: superuser!.name as string, restricted: true });
    expect(await warning()).not.toBeNull();
    await db.update(environments).set({ dbRole: access.dbRole }).where(eq(environments.id, a.environment!.id));
    await claim({ role: access.dbRole, restricted: true });
    expect(await warning()).toBeNull();

    // The runner still connected with the full DSN (a Claude session forged the heartbeat): warned.
    const full = await connect(process.env.DATABASE_URL!, 'nuera-runner');
    try {
      expect(await warning()).toBe('Le serveur VPS-3 accède encore à toute la base de données.');
      expect((await admin.getServer(actorOf(a), a.environment!.id)).databaseRestricted).toBe(false);
    } finally {
      await full.end({ timeout: 5 });
    }
    // Its connections named after the server must use its role.
    const named = await connect(process.env.DATABASE_URL!, `nuera-runner-lease:${a.environment!.id}`);
    try {
      expect(await warning()).not.toBeNull();
    } finally {
      await named.end({ timeout: 5 });
    }
    // The runner really uses the restricted DSN: no warning.
    const restricted = await connect(access.databaseUrl, 'nuera-runner');
    try {
      // (the backends closed above leave pg_stat_activity a few milliseconds later)
      await expect.poll(warning, { timeout: 5_000 }).toBeNull();
    } finally {
      await restricted.end({ timeout: 5 });
    }
    // Another server's runner on ITS restricted role (heartbeat not written yet) is not a runner
    // with the full DSN: the default server stays restricted.
    const other = await admin.registerServer(actorOf(a), { name: 'VPS-7', url: 'http://runner-vps-7:4100' });
    createdRoles.add(other.dbRole);
    const neighbour = await connect(other.databaseUrl, 'nuera-runner');
    try {
      expect(await warning()).toBeNull();
    } finally {
      await neighbour.end({ timeout: 5 });
    }
  });

  it("le journal d'instance montre les actions d'administration, jamais Git, projets, sessions ni terminaux", async () => {
    await admin.createInvitation(actorOf(a), { email: 'nadia@example.test' });
    await db.insert(auditLog).values([
      { action: 'git.push', summary: 'push de crm-core', spaceId: b.space.id, actorUserId: b.user.id },
      { action: 'session.created', summary: 'session créée', spaceId: b.space.id, actorUserId: b.user.id },
    ]);
    const journal = await admin.getInstanceJournal(actorOf(a));
    expect(journal.items.map((item) => item.action)).toContain('admin.invitation_created');
    expect(journal.items.filter((item) => /^(git|project|session|terminal)\./.test(item.action))).toEqual([]);
  });
});

describe('/api/admin/** · réservé aux administrateurs', () => {
  const routes = async () => ({
    accounts: await import('@/app/api/admin/accounts/route'),
    account: await import('@/app/api/admin/accounts/[id]/route'),
    disable: await import('@/app/api/admin/accounts/[id]/disable/route'),
    enable: await import('@/app/api/admin/accounts/[id]/enable/route'),
    role: await import('@/app/api/admin/accounts/[id]/role/route'),
    recovery: await import('@/app/api/admin/accounts/[id]/recovery/route'),
    invitations: await import('@/app/api/admin/invitations/route'),
    invitation: await import('@/app/api/admin/invitations/[id]/route'),
    servers: await import('@/app/api/admin/servers/route'),
    server: await import('@/app/api/admin/servers/[id]/route'),
    verify: await import('@/app/api/admin/servers/[id]/verify/route'),
    assign: await import('@/app/api/admin/servers/[id]/assign/route'),
    rotate: await import('@/app/api/admin/servers/[id]/rotate/route'),
    retire: await import('@/app/api/admin/servers/[id]/retire/route'),
    restrict: await import('@/app/api/admin/servers/[id]/restrict-database/route'),
    instance: await import('@/app/api/admin/instance/route'),
    journal: await import('@/app/api/admin/journal/route'),
  });

  it("un membre reçoit 403 sur chaque route, la même réponse quel que soit l'identifiant, sans rien écrire", async () => {
    const r = await routes();
    const cases = (id: string): Array<[Handler, string, string, unknown?]> => [
      [r.accounts.GET as Handler, 'GET', '/api/admin/accounts'],
      [r.account.GET as Handler, 'GET', `/api/admin/accounts/${id}`],
      [r.account.DELETE as Handler, 'DELETE', `/api/admin/accounts/${id}`],
      [r.disable.POST as Handler, 'POST', `/api/admin/accounts/${id}/disable`, { stopSessions: true }],
      [r.enable.POST as Handler, 'POST', `/api/admin/accounts/${id}/enable`],
      [r.role.POST as Handler, 'POST', `/api/admin/accounts/${id}/role`, { role: 'admin' }],
      [r.recovery.POST as Handler, 'POST', `/api/admin/accounts/${id}/recovery`, { password: 'x' }],
      [r.invitations.GET as Handler, 'GET', '/api/admin/invitations'],
      [r.invitations.POST as Handler, 'POST', '/api/admin/invitations', { email: 'intrus@example.test', role: 'admin' }],
      [r.invitation.DELETE as Handler, 'DELETE', `/api/admin/invitations/${id}`],
      [r.servers.GET as Handler, 'GET', '/api/admin/servers'],
      [r.servers.POST as Handler, 'POST', '/api/admin/servers', { name: 'VPS-X', url: 'http://runner:4100' }],
      [r.server.GET as Handler, 'GET', `/api/admin/servers/${id}`],
      [r.server.PATCH as Handler, 'PATCH', `/api/admin/servers/${id}`, { name: 'Renommé' }],
      [r.verify.POST as Handler, 'POST', `/api/admin/servers/${id}/verify`],
      [r.assign.POST as Handler, 'POST', `/api/admin/servers/${id}/assign`, { userId: 'x' }],
      [r.rotate.POST as Handler, 'POST', `/api/admin/servers/${id}/rotate`],
      [r.retire.POST as Handler, 'POST', `/api/admin/servers/${id}/retire`],
      [r.restrict.POST as Handler, 'POST', `/api/admin/servers/${id}/restrict-database`],
      [r.instance.GET as Handler, 'GET', '/api/admin/instance'],
      [r.instance.PATCH as Handler, 'PATCH', '/api/admin/instance', { invitationTtlHours: 1 }],
      [r.journal.GET as Handler, 'GET', '/api/admin/journal'],
    ];
    state.current = b.user;
    const before = (await db.select().from(auditLog)).length;
    for (const [real, unknown] of [
      [a.user.id, 'compte-inconnu'],
      [a.environment!.id, crypto.randomUUID()],
    ] as const) {
      const realCases = cases(real);
      const unknownCases = cases(unknown);
      for (let index = 0; index < realCases.length; index += 1) {
        const [handler, method, path, body] = realCases[index]!;
        const answer = await call(handler, method, path, { id: real }, body);
        expect(answer, `${method} ${path}`).toEqual({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'Action réservée aux administrateurs.' } } });
        const [otherHandler, otherMethod, otherPath, otherBody] = unknownCases[index]!;
        expect(await call(otherHandler, otherMethod, otherPath, { id: unknown }, otherBody)).toEqual(answer);
      }
    }
    expect((await db.select().from(auditLog)).length).toBe(before);
    const [server] = await db.select({ name: environments.name }).from(environments).where(eq(environments.id, a.environment!.id));
    expect(server!.name).toBe('VPS-3');

    state.current = null;
    expect((await call(r.accounts.GET as Handler, 'GET', '/api/admin/accounts')).status).toBe(401);
  });

  it("un administrateur : listes, identifiant inconnu = identifiant mal formé (404), corps invalide (422), réglage d'instance", async () => {
    const r = await routes();
    const accounts = await call(r.accounts.GET as Handler, 'GET', '/api/admin/accounts');
    expect(accounts.status).toBe(200);
    expect((accounts.body as { accounts: unknown[] }).accounts).toHaveLength(2);

    for (const id of [crypto.randomUUID(), 'pas-un-uuid']) {
      expect(await call(r.server.GET as Handler, 'GET', `/api/admin/servers/${id}`, { id })).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Serveur introuvable.' } } });
      expect(await call(r.verify.POST as Handler, 'POST', `/api/admin/servers/${id}/verify`, { id })).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Serveur introuvable.' } } });
      expect(await call(r.account.GET as Handler, 'GET', `/api/admin/accounts/${id}`, { id })).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Compte introuvable.' } } });
      expect(await call(r.invitation.DELETE as Handler, 'DELETE', `/api/admin/invitations/${id}`, { id })).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Invitation introuvable.' } } });
    }

    const invited = await call(r.invitations.POST as Handler, 'POST', '/api/admin/invitations', {}, { email: 'nadia@example.test', role: 'member' });
    expect(invited.status).toBe(200);
    expect((invited.body as { url: string }).url).toMatch(/^http:\/\/localhost:3105\/invitation\/[A-Za-z0-9_-]{43}$/);
    expect((await call(r.invitations.POST as Handler, 'POST', '/api/admin/invitations', {}, { email: 'pas-une-adresse' })).status).toBe(422);

    expect((await call(r.instance.PATCH as Handler, 'PATCH', '/api/admin/instance', {}, { projectsRoot: '/srv' })).status).toBe(422);
    const patched = await call(r.instance.PATCH as Handler, 'PATCH', '/api/admin/instance', {}, { invitationTtlHours: 72 });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ view: { settings: { invitationTtlHours: 72 } } });
    const [journal] = await db.select().from(auditLog).where(inArray(auditLog.action, ['instance.settings_updated']));
    expect(journal).toMatchObject({ actorUserId: a.user.id });

    // The owner is never disabled, demoted nor deleted, even through the routes.
    for (const [handler, method, path, body] of [
      [r.disable.POST, 'POST', `/api/admin/accounts/${a.user.id}/disable`, { stopSessions: false }],
      [r.role.POST, 'POST', `/api/admin/accounts/${a.user.id}/role`, { role: 'member' }],
      [r.account.DELETE, 'DELETE', `/api/admin/accounts/${a.user.id}`, undefined],
    ] as Array<[Handler, string, string, unknown]>) {
      const answer = await call(handler, method, path, { id: a.user.id }, body);
      expect(answer.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
      expect(answer.status, `${method} ${path}`).toBeLessThan(500);
    }
    const [owner] = await db.select({ role: user.role, disabledAt: user.disabledAt, deletedAt: user.deletedAt }).from(user).where(eq(user.id, a.user.id));
    expect(owner).toEqual({ role: 'owner', disabledAt: null, deletedAt: null });
  });
});

describe('rôle refusé par PostgreSQL', () => {
  it('donne un message actionnable en français', async () => {
    const { roleRefusal } = await import('./db-roles');
    const error = roleRefusal(new Error('permission denied to create role'));
    expect(error).toMatchObject({ code: 'CONFLICT', message: "PostgreSQL refuse de créer l'accès restreint du serveur : rien n'a été enregistré." });
    expect(error.detail).toMatch(/CREATEROLE/);
    expect(error.detail).toMatch(/permission denied to create role/);
  });
});
