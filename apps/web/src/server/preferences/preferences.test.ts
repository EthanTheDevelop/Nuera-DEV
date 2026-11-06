import { randomUUID } from 'node:crypto';
import { appSettings, auditLog, environments, operations, projects, sessions, spaceSettings, worktrees } from '@nuera/db/schema';
import type { WorktreeDto } from '@nuera/shared/runner';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@/server/tenancy/context';
import { useTestEncryptionKey } from '@/server/tenancy/test/db';
import { createTestAccount, type TestAccount } from '@/server/tenancy/test/fixtures';
import { closeTestDb, prepareTestDatabase, resetTables, TEST_ENVIRONMENT_ID, TEST_SPACE_ID, TEST_USER_ID } from './test/db';

/**
 * Server module of Paramètres against a real PostgreSQL database (`nuera_w5_settings_prefs`) and a
 * mocked runner client per server (the runner itself is exercised by the e2e suite on the test
 * stack). Two accounts: the owner A (default server « VPS-3 ») and a member B with its own server —
 * every reader and writer only ever touches the account's own space, server and preferences.
 */

type RunnerMockFn = (input: { params: { worktreeId: string; projectId: string }; query: Record<string, unknown> }) => Promise<unknown>;

const runnerMock = vi.hoisted(() => ({
  listWorktrees: vi.fn<RunnerMockFn>(),
  removeWorktree: vi.fn<RunnerMockFn>(),
  claudeStatus: vi.fn<RunnerMockFn>(),
  health: vi.fn<RunnerMockFn>(),
  /** Server each runner client was asked for (getRunnerForEnvironment). */
  servers: [] as string[],
}));

vi.mock('@/server/runner/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/runner/client')>();
  return {
    ...actual,
    getRunnerForEnvironment: (environmentId: string) => {
      runnerMock.servers.push(environmentId);
      return runnerMock;
    },
  };
});

const DAY = 86_400_000;

let a: TestAccount;
let b: TestAccount;

beforeAll(async () => {
  useTestEncryptionKey();
  await prepareTestDatabase('prefs');
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  a = await resetTables();
  b = await createTestAccount({ role: 'member', name: 'Lina Moreau', email: 'lina@example.test', environment: { configSource: 'db', name: 'VPS-4' } });
  for (const fn of [runnerMock.listWorktrees, runnerMock.removeWorktree, runnerMock.claudeStatus, runnerMock.health]) fn.mockReset();
  runnerMock.servers.length = 0;
});

async function db() {
  return (await import('@/server/db')).db;
}

async function insertProject(account: Pick<TestAccount, 'space' | 'environment'>, name = 'Devis Express') {
  const slug = `${name.toLowerCase().replace(/\s+/g, '-')}-${randomUUID().slice(0, 6)}`;
  const [row] = await (await db())
    .insert(projects)
    .values({
      spaceId: account.space.id,
      environmentId: account.environment!.id,
      slug,
      name,
      githubFullName: `atelier/${slug}`,
      cloneUrl: 'https://example.test/x.git',
      path: `/srv/dev/${slug}`,
      status: 'ready',
    })
    .returning();
  return row!;
}

function dto(patch: Partial<WorktreeDto> & Pick<WorktreeDto, 'id' | 'projectId' | 'name'>): WorktreeDto {
  return {
    branch: `feature/${patch.name}`,
    baseBranch: 'main',
    path: `/srv/dev/.worktrees/${patch.name}`,
    isPrimary: false,
    status: 'active',
    createdAt: new Date(Date.now() - 60 * DAY).toISOString(),
    lastUsedAt: null,
    dirtyFiles: 0,
    ahead: 0,
    behind: 0,
    liveSessionId: null,
    ...patch,
  };
}

describe('settings by scope', () => {
  it('reads each key from its scope, with what the account may change', async () => {
    const { getSettingsValues } = await import('./index');
    const owner = await getSettingsValues(a.ctx);
    expect(owner).toMatchObject({ serverName: 'VPS-3', maxConcurrentSessions: 4, maxConcurrentSessionsCap: 16, defaultPermissionMode: 'manual', theme: 'light' });
    expect(owner.editable).toMatchObject({ webSessionIdleHours: true, serverName: true, maxConcurrentSessions: true, defaultModel: true, theme: true, gitAuthorEmail: true });

    const member = await getSettingsValues(b.ctx);
    expect(member.serverName).toBe('VPS-4');
    // Instance keys and the server's name: read-only « Réglé par un administrateur » for a member.
    expect(member.editable).toMatchObject({
      webSessionIdleHours: false,
      webSessionMaxDays: false,
      invitationTtlHours: false,
      forceBlockBypassPermissions: false,
      serverName: false,
      serverLocation: false,
      maxConcurrentSessions: true,
      sessionMemoryLimitMb: true,
      defaultPermissionMode: true,
      gitAuthorName: true,
    });
  });

  it('writes each key in its scope and audits it; one space never moves another', async () => {
    const { getSettingsValues, updateSettings } = await import('./index');
    const result = await updateSettings(a.ctx, { maxConcurrentSessions: 6, defaultPermissionMode: 'acceptEdits', theme: 'dark' });
    expect(result.refused).toBeNull();
    expect(result.values).toMatchObject({ maxConcurrentSessions: 6, defaultPermissionMode: 'acceptEdits', theme: 'dark' });
    expect(result.results).toMatchObject({ maxConcurrentSessions: { status: 'updated' }, defaultPermissionMode: { status: 'updated' }, theme: { status: 'updated' } });

    // B's space, server and preferences are untouched.
    expect(await getSettingsValues(b.ctx)).toMatchObject({ maxConcurrentSessions: 4, defaultPermissionMode: 'manual', theme: 'light' });

    const rows = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'settings.updated'));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((row) => row.actorUserId === TEST_USER_ID)).toBe(true);
  });

  it('refuses an instance key to a member (403, nothing written) but keeps its own scopes open', async () => {
    const { updateSettings, getSettingsValues } = await import('./index');
    const before = await (await db()).select().from(appSettings);
    await expect(updateSettings(b.ctx, { webSessionIdleHours: 2 })).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Réglage réservé aux administrateurs.' });
    await expect(updateSettings(b.ctx, { forceBlockBypassPermissions: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateSettings(b.ctx, { serverName: 'Mon serveur' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await (await db()).select().from(appSettings)).toEqual(before);

    const own = await updateSettings(b.ctx, { defaultPermissionMode: 'plan', maxConcurrentSessions: 2, gitAuthorEmail: 'Camille@Users.Noreply.GitHub.com' });
    expect(own.values).toMatchObject({ defaultPermissionMode: 'plan', maxConcurrentSessions: 2, gitAuthorEmail: 'camille@users.noreply.github.com' });
    expect((await getSettingsValues(a.ctx)).defaultPermissionMode).toBe('manual');
    const [server] = await (await db()).select().from(environments).where(eq(environments.id, TEST_ENVIRONMENT_ID));
    expect(server!.maxConcurrentSessions).toBe(4);
  });

  it('a mixed patch of a member writes its own keys and reports the refused one', async () => {
    const { updateSettings } = await import('./index');
    const result = await updateSettings(b.ctx, { webSessionMaxDays: 3, remoteControlByDefault: true });
    expect(result.values.remoteControlByDefault).toBe(true);
    expect(result.values.webSessionMaxDays).toBe(30);
    expect(result.refused).toMatchObject({ code: 'FORBIDDEN' });
    expect(result.results.webSessionMaxDays).toMatchObject({ status: 'refused', code: 'FORBIDDEN' });
  });

  it('validates every key before writing anything, and holds the administrator ceiling', async () => {
    const { updateSettings, getSettingsValues } = await import('./index');
    await expect(updateSettings(a.ctx, { maxConcurrentSessions: 99, theme: 'dark' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings(a.ctx, { inconnu: 1 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings(a.ctx, {})).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings(a.ctx, { gitAuthorName: 'Ethan <x>' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await getSettingsValues(a.ctx)).theme).toBe('light');

    await (await db()).update(environments).set({ maxConcurrentSessionsCap: 3 }).where(eq(environments.id, b.environment!.id));
    const { invalidateSettingsCache } = await import('@/server/settings');
    invalidateSettingsCache();
    await expect(updateSettings(b.ctx, { maxConcurrentSessions: 5 })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await getSettingsValues(b.ctx)).maxConcurrentSessionsCap).toBe(3);
  });

  it('keeps the bypass mode refused while blocked, and shows the instance block as read-only', async () => {
    const { updateSettings, getSettingsValues } = await import('./index');
    await expect(updateSettings(a.ctx, { defaultPermissionMode: 'bypassPermissions' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await updateSettings(a.ctx, { forceBlockBypassPermissions: true });
    const member = await getSettingsValues(b.ctx);
    expect(member.forceBlockBypassPermissions).toBe(true);
    expect(member.editable.blockBypassPermissions).toBe(false);
  });

  it('without a server: no server values, server keys refused (409), other scopes open', async () => {
    const c = await createTestAccount({ role: 'member', name: 'Sans Serveur', environment: false });
    const { getSettingsValues, updateSettings } = await import('./index');
    const values = await getSettingsValues(c.ctx);
    expect(values).toMatchObject({ serverName: null, serverLocation: null, maxConcurrentSessions: null, maxConcurrentSessionsCap: null });
    expect(values.editable).toMatchObject({ maxConcurrentSessions: false, serverName: false, defaultModel: true, theme: true });
    await expect(updateSettings(c.ctx, { maxConcurrentSessions: 2 })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await updateSettings(c.ctx, { theme: 'system' })).values.theme).toBe('system');
  });
});

describe('Paramètres page without a server', () => {
  it('says so in every section that needs a runner, without calling any', async () => {
    const c = await createTestAccount({ role: 'member', name: 'Sans Serveur', environment: false });
    const { loadSettingsPage } = await import('./index');
    const page = await loadSettingsPage(c.ctx);
    expect(page.environment).toBeNull();
    expect(page.profile).toEqual({ name: 'Sans Serveur', email: c.user.email, role: 'member' });
    for (const section of [page.claude, page.health, page.liveSessions, page.uptime, page.metrics, page.worktrees]) {
      expect(section).toMatchObject({ ok: false, error: { noEnvironment: true } });
    }
    expect(runnerMock.servers).toEqual([]);
  });
});

describe('models seen by the CLI', () => {
  it("lists distinct model ids of the space's sessions, most recent first, never another space's", async () => {
    const project = await insertProject(a);
    const other = await insertProject(b, 'Autre');
    const now = Date.now();
    const env = TEST_ENVIRONMENT_ID;
    await (await db()).insert(sessions).values([
      { id: randomUUID(), projectId: project.id, environmentId: env, title: 'a', cliStatus: { model: { id: 'claude-opus-4-1', displayName: 'Opus 4.1' } }, updatedAt: new Date(now - 1000) },
      { id: randomUUID(), projectId: project.id, environmentId: env, title: 'b', cliStatus: { model: { id: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5' } }, updatedAt: new Date(now) },
      { id: randomUUID(), projectId: project.id, environmentId: env, title: 'c', cliStatus: { model: { id: 'claude-opus-4-1', displayName: 'Opus 4.1' } }, updatedAt: new Date(now - 5000) },
      { id: randomUUID(), projectId: project.id, environmentId: env, title: 'd', cliStatus: { model: { id: 'bad id; rm -rf', displayName: 'x' } } },
      { id: randomUUID(), projectId: project.id, environmentId: env, title: 'e', cliStatus: null },
      { id: randomUUID(), projectId: other.id, environmentId: b.environment!.id, title: 'f', cliStatus: { model: { id: 'model-de-b', displayName: 'B' } }, updatedAt: new Date(now + 1000) },
    ]);
    const { listSeenModels } = await import('./index');
    expect(await listSeenModels(a.ctx)).toEqual([
      { id: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5' },
      { id: 'claude-opus-4-1', displayName: 'Opus 4.1' },
    ]);
    expect(await listSeenModels(b.ctx)).toEqual([{ id: 'model-de-b', displayName: 'B' }]);
  });
});

describe('inactive worktrees', () => {
  it('selects session worktrees idle for the configured days and excludes dirty / live ones', async () => {
    const { selectStaleWorktrees } = await import('./index');
    const now = new Date('2026-11-05T12:00:00Z');
    const old = new Date(now.getTime() - 40 * DAY).toISOString();
    const candidates = [
      { worktree: dto({ id: '00000000-0000-4000-8000-000000000001', projectId: 'p', name: 'contrastes', createdAt: old }), projectId: 'p', projectName: 'Site', lastSessionActivityAt: null },
      { worktree: dto({ id: '00000000-0000-4000-8000-000000000002', projectId: 'p', name: 'galerie', createdAt: old, dirtyFiles: 2 }), projectId: 'p', projectName: 'Atelier', lastSessionActivityAt: null },
      { worktree: dto({ id: '00000000-0000-4000-8000-000000000003', projectId: 'p', name: 'recent', createdAt: old }), projectId: 'p', projectName: 'Site', lastSessionActivityAt: new Date(now.getTime() - 2 * DAY) },
      { worktree: dto({ id: '00000000-0000-4000-8000-000000000004', projectId: 'p', name: 'main', createdAt: old, isPrimary: true }), projectId: 'p', projectName: 'Site', lastSessionActivityAt: null },
      { worktree: dto({ id: '00000000-0000-4000-8000-000000000005', projectId: 'p', name: 'vivant', createdAt: old, liveSessionId: '00000000-0000-4000-8000-0000000000aa' }), projectId: 'p', projectName: 'Site', lastSessionActivityAt: null },
      { worktree: dto({ id: '00000000-0000-4000-8000-000000000006', projectId: 'p', name: 'illisible', createdAt: old, dirtyFiles: null }), projectId: 'p', projectName: 'Site', lastSessionActivityAt: null },
    ];
    const items = selectStaleWorktrees(candidates, 30, now);
    expect(items.map((item) => [item.name, item.eligible, item.excludedReason])).toEqual([
      ['contrastes', true, null],
      ['galerie', false, '2 fichiers non commités'],
      ['vivant', false, 'une session Claude y travaille'],
      ['illisible', false, 'état Git illisible'],
    ]);
  });

  it('re-checks eligibility on the server, never forces, keeps branches and audits each removal in the space', async () => {
    const project = await insertProject(a);
    const database = await db();
    const env = TEST_ENVIRONMENT_ID;
    const [clean] = await database.insert(worktrees).values({ projectId: project.id, environmentId: env, name: 'contrastes', branch: 'feature/contrastes', path: '/srv/dev/.w/contrastes' }).returning();
    const [dirty] = await database.insert(worktrees).values({ projectId: project.id, environmentId: env, name: 'galerie', branch: 'feature/galerie', path: '/srv/dev/.w/galerie' }).returning();
    const [raced] = await database.insert(worktrees).values({ projectId: project.id, environmentId: env, name: 'course', branch: 'feature/course', path: '/srv/dev/.w/course' }).returning();
    const old = new Date(Date.now() - 45 * DAY).toISOString();
    // An old session in this worktree: still inactive (the runner then finds it dirty on removal).
    await database.insert(sessions).values({ id: randomUUID(), projectId: project.id, environmentId: env, worktreeId: raced!.id, title: 'x', lastActivityAt: new Date(Date.now() - 50 * DAY) });
    runnerMock.listWorktrees.mockImplementation(async ({ params }) =>
      params.projectId === project.id
        ? {
            worktrees: [
              dto({ id: clean!.id, projectId: project.id, name: 'contrastes', createdAt: old }),
              dto({ id: dirty!.id, projectId: project.id, name: 'galerie', createdAt: old, dirtyFiles: 3 }),
              dto({ id: raced!.id, projectId: project.id, name: 'course', createdAt: old }),
            ],
          }
        : { worktrees: [] },
    );
    const { RunnerError } = await import('@/server/runner/errors');
    runnerMock.removeWorktree.mockImplementation(async ({ params }: { params: { worktreeId: string } }) => {
      if (params.worktreeId === raced!.id) throw new RunnerError('CONFLICT', 'Modifications non commitées.', { reason: 'WORKTREE_DIRTY' });
      return { operationId: null, removed: true, branchDeleted: false };
    });

    const { listStaleWorktrees, removeStaleWorktrees } = await import('./index');
    const view = await listStaleWorktrees(a.ctx);
    expect(view.staleDays).toBe(30);
    expect(view.items.filter((item) => item.eligible).map((item) => item.name).sort()).toEqual(['contrastes', 'course']);

    const result = await removeStaleWorktrees(a.ctx, { ids: [clean!.id, dirty!.id, raced!.id, '00000000-0000-4000-8000-00000000ffff'] });
    expect(result.removed).toEqual([{ id: clean!.id, name: 'contrastes' }]);
    expect(result.skipped.map((item) => [item.name, item.reason])).toEqual([
      ['galerie', '3 fichiers non commités'],
      ['course', 'des modifications non commitées sont apparues'],
      ['00000000', "n'est plus inactif ou n'existe plus"],
    ]);
    for (const call of runnerMock.removeWorktree.mock.calls) expect(call[0].query).toEqual({ force: false, deleteBranch: false });
    const audits = await database.select().from(auditLog).where(eq(auditLog.action, 'maintenance.worktree_removed'));
    expect(audits.map((row) => [row.summary, row.spaceId, row.environmentId])).toEqual([
      ['worktree inactif contrastes (feature/contrastes) supprimé de Devis Express, branche conservée', TEST_SPACE_ID, TEST_ENVIRONMENT_ID],
    ]);
    await expect(removeStaleWorktrees(a.ctx, { ids: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it("lists only the projects of the account's space on its server; another space's worktree is never removed", async () => {
    const projectA = await insertProject(a, 'Projet A');
    const [worktreeA] = await (await db())
      .insert(worktrees)
      .values({ projectId: projectA.id, environmentId: TEST_ENVIRONMENT_ID, name: 'chez-a', branch: 'feature/a', path: '/srv/dev/.w/chez-a' })
      .returning();
    runnerMock.listWorktrees.mockResolvedValue({ worktrees: [] });
    const { listStaleWorktrees, removeStaleWorktrees } = await import('./index');
    const view = await listStaleWorktrees(b.ctx);
    expect(view.items).toEqual([]);
    // B's runner client only, never asked about A's project.
    expect(runnerMock.servers.every((id) => id === b.environment!.id)).toBe(true);
    expect(runnerMock.listWorktrees).not.toHaveBeenCalled();

    const result = await removeStaleWorktrees(b.ctx, { ids: [worktreeA!.id] });
    expect(result).toEqual({ removed: [], skipped: [{ id: worktreeA!.id, name: worktreeA!.id.slice(0, 8), reason: "n'est plus inactif ou n'existe plus" }] });
    expect(runnerMock.removeWorktree).not.toHaveBeenCalled();
    expect(await (await db()).select().from(auditLog).where(eq(auditLog.action, 'maintenance.worktree_removed'))).toEqual([]);
  });

  it('reports the runner as unavailable instead of an empty list', async () => {
    await insertProject(a);
    const { RunnerError } = await import('@/server/runner/errors');
    runnerMock.listWorktrees.mockRejectedValue(new RunnerError('RUNNER_UNAVAILABLE', 'VPS-3 ne répond pas.'));
    const { listStaleWorktrees, load } = await import('./index');
    const result = await load(() => listStaleWorktrees(a.ctx));
    expect(result).toMatchObject({ ok: false, error: { unavailable: true } });
  });

  it('follows the stale delay of the space', async () => {
    await (await db()).update(spaceSettings).set({ worktreeStaleDays: 7 }).where(eq(spaceSettings.spaceId, b.space.id));
    const { invalidateSettingsCache } = await import('@/server/settings');
    invalidateSettingsCache();
    runnerMock.listWorktrees.mockResolvedValue({ worktrees: [] });
    const { listStaleWorktrees } = await import('./index');
    expect((await listStaleWorktrees(b.ctx)).staleDays).toBe(7);
    expect((await listStaleWorktrees(a.ctx)).staleDays).toBe(30);
  });
});

describe('journaux', () => {
  async function operationOf(account: Pick<TestAccount, 'space' | 'environment'>, title: string) {
    const project = await insertProject(account, title);
    const [op] = await (await db())
      .insert(operations)
      .values({ kind: 'pull', status: 'failed', projectId: project.id, environmentId: account.environment!.id, title, log: 'fetch…\n', error: { code: 'X', message: 'délai dépassé', raw: 'fatal: timeout' } })
      .returning();
    return { project, op: op! };
  }

  it('lists the operations of the space and serves one journal on demand', async () => {
    const { project, op } = await operationOf(a, 'Devis Express');
    const { listOperationLogs, getOperationLog } = await import('./index');
    const items = await listOperationLogs(a.ctx);
    expect(items).toEqual([expect.objectContaining({ id: op.id, kind: 'pull', status: 'failed', projectName: project.name, errorMessage: 'délai dépassé', hasLog: true })]);
    expect(await getOperationLog(a.ctx, op.id)).toEqual({ log: 'fetch…\n', raw: 'fatal: timeout' });
  });

  it("answers another space's operation exactly like an unknown one", async () => {
    const { op } = await operationOf(a, 'Chez A');
    await operationOf(b, 'Chez B');
    const { listOperationLogs, getOperationLog } = await import('./index');
    expect((await listOperationLogs(b.ctx)).map((item) => item.title)).toEqual(['Chez B']);
    const foreign = await getOperationLog(b.ctx, op.id).catch((error: unknown) => error);
    const unknown = await getOperationLog(b.ctx, randomUUID()).catch((error: unknown) => error);
    const malformed = await getOperationLog(b.ctx, 'nope').catch((error: unknown) => error);
    for (const error of [foreign, unknown, malformed]) expect(error).toMatchObject({ code: 'NOT_FOUND', message: 'Opération introuvable.' });
  });

  it('lists the ended sessions of the space only', async () => {
    const projectA = await insertProject(a, 'Chez A');
    const projectB = await insertProject(b, 'Chez B');
    await (await db()).insert(sessions).values([
      { id: randomUUID(), projectId: projectA.id, environmentId: TEST_ENVIRONMENT_ID, title: 'session de A', status: 'finished' },
      { id: randomUUID(), projectId: projectB.id, environmentId: b.environment!.id, title: 'session de B', status: 'failed' },
      { id: randomUUID(), projectId: projectB.id, environmentId: b.environment!.id, title: 'en cours', status: 'running' },
    ]);
    const { listSessionLogs } = await import('./index');
    expect((await listSessionLogs(a.ctx)).map((item) => item.title)).toEqual(['session de A']);
    expect((await listSessionLogs(b.ctx)).map((item) => item.title)).toEqual(['session de B']);
  });
});

describe('personal journal', () => {
  it("shows my events and an administrator's actions on my account, never another account's", async () => {
    const { audit } = await import('@/server/security/audit');
    const { getJournalPage } = await import('./index');
    await audit({ action: 'auth.sign_in', summary: 'connexion de A', actorUserId: a.user.id, actorKind: 'user', subjectUserId: a.user.id });
    await audit({ action: 'auth.sign_in', summary: 'connexion de B', actorUserId: b.user.id, actorKind: 'user', subjectUserId: b.user.id });
    await audit({
      action: 'admin.sessions_revoked',
      summary: 'accès de Lina fermés',
      actorUserId: a.user.id,
      actorKind: 'user',
      actorLabel: a.user.email,
      subjectUserId: b.user.id,
    });
    const mine = await getJournalPage(b.ctx);
    expect(mine.items.map((item) => [item.summary, item.by])).toEqual([
      ['accès de Lina fermés', a.user.email],
      ['connexion de B', null],
    ]);
    const owner = await getJournalPage(a.ctx);
    expect(owner.items.map((item) => item.summary)).not.toContain('connexion de B');
  });
});

describe('Claude CLI', () => {
  it("keeps only the whitelisted fields of claude auth status, from the account's own server", async () => {
    runnerMock.claudeStatus.mockResolvedValue({
      checkedAt: '2026-11-05T10:00:00.000Z',
      installed: true,
      version: '2.1.999',
      auth: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', loginExpiresAt: null, email: 'x@y.z', organization: 'Org' },
      state: 'connected',
      agents: [],
      error: null,
    });
    const { getClaudeCli } = await import('./index');
    const view = await getClaudeCli(b.ctx, { refresh: true });
    expect(runnerMock.servers).toEqual([b.environment!.id]);
    // The account's own Claude connection (lot P1: one per account of a shared server).
    expect(runnerMock.claudeStatus).toHaveBeenCalledWith({ query: { refresh: true, spaceId: b.ctx.space.id } }, {});
    expect(view).toEqual({
      checkedAt: '2026-11-05T10:00:00.000Z',
      state: 'connected',
      installed: true,
      version: '2.1.999',
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      loginExpiresAt: null,
      error: null,
    });
    expect(JSON.stringify(view)).not.toContain('x@y.z');
  });

  it('refuses without a server (NO_ENVIRONMENT), without any runner call', async () => {
    const noServer: RequestContext = { ...b.ctx, environment: null };
    const { getClaudeCli } = await import('./index');
    await expect(getClaudeCli(noServer)).rejects.toMatchObject({ code: 'CONFLICT', reason: 'NO_ENVIRONMENT' });
    expect(runnerMock.claudeStatus).not.toHaveBeenCalled();
  });
});

