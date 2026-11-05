import { randomUUID } from 'node:crypto';
import { auditLog, operations, projects, sessions, worktrees } from '@nuera/db/schema';
import type { WorktreeDto } from '@nuera/shared/runner';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, prepareTestDatabase, resetTables, TEST_USER_ID } from './test/db';

/**
 * Server module of Paramètres against a real PostgreSQL database (`nuera_settings_prefs`) and a
 * mocked runner client (the runner itself is exercised by the e2e suite on the test stack).
 */

type RunnerMockFn = (input: { params: { worktreeId: string; projectId: string }; query: Record<string, unknown> }) => Promise<unknown>;

const runnerMock = vi.hoisted(() => ({
  listWorktrees: vi.fn<RunnerMockFn>(),
  removeWorktree: vi.fn<RunnerMockFn>(),
  claudeStatus: vi.fn<RunnerMockFn>(),
}));

vi.mock('@/server/runner/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/runner/client')>();
  return { ...actual, runner: runnerMock };
});

const DAY = 86_400_000;

beforeAll(async () => {
  await prepareTestDatabase('prefs');
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTables();
  runnerMock.listWorktrees.mockReset();
  runnerMock.removeWorktree.mockReset();
  runnerMock.claudeStatus.mockReset();
});

async function db() {
  return (await import('@/server/db')).db;
}

async function insertProject(name = 'Devis Express') {
  const [row] = await (await db())
    .insert(projects)
    .values({ slug: name.toLowerCase().replace(/\s+/g, '-'), name, githubFullName: `atelier/${name}`, cloneUrl: 'https://example.test/x.git', path: `/srv/dev/${name}`, status: 'ready' })
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

describe('settings', () => {
  it('updates a validated subset, audits it, and refuses fields outside the subset', async () => {
    const { updateSettings, getSettingsValues } = await import('./index');
    const updated = await updateSettings({ maxConcurrentSessions: 6, defaultPermissionMode: 'acceptEdits' }, { id: TEST_USER_ID });
    expect(updated).toMatchObject({ maxConcurrentSessions: 6, defaultPermissionMode: 'acceptEdits' });
    expect((await getSettingsValues()).maxConcurrentSessions).toBe(6);

    const rows = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'settings.updated'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe('réglages modifiés : sessions parallèles, mode de permission');
    expect(rows[0]!.actorUserId).toBe(TEST_USER_ID);

    await expect(updateSettings({ projectsRoot: '/tmp' }, { id: TEST_USER_ID })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings({ theme: 'dark' }, { id: TEST_USER_ID })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings({ maxConcurrentSessions: 99 }, { id: TEST_USER_ID })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSettings({}, { id: TEST_USER_ID })).rejects.toMatchObject({ code: 'VALIDATION' });
    // The bypass mode stays refused while it is blocked.
    await expect(updateSettings({ defaultPermissionMode: 'bypassPermissions' }, { id: TEST_USER_ID })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('models seen by the CLI', () => {
  it('lists distinct model ids from the sessions status lines, most recent first, never invented', async () => {
    const project = await insertProject();
    const now = Date.now();
    await (await db()).insert(sessions).values([
      { id: randomUUID(), projectId: project.id, title: 'a', cliStatus: { model: { id: 'claude-opus-4-1', displayName: 'Opus 4.1' } }, updatedAt: new Date(now - 1000) },
      { id: randomUUID(), projectId: project.id, title: 'b', cliStatus: { model: { id: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5' } }, updatedAt: new Date(now) },
      { id: randomUUID(), projectId: project.id, title: 'c', cliStatus: { model: { id: 'claude-opus-4-1', displayName: 'Opus 4.1' } }, updatedAt: new Date(now - 5000) },
      { id: randomUUID(), projectId: project.id, title: 'd', cliStatus: { model: { id: 'bad id; rm -rf', displayName: 'x' } } },
      { id: randomUUID(), projectId: project.id, title: 'e', cliStatus: null },
    ]);
    const { listSeenModels } = await import('./index');
    expect(await listSeenModels()).toEqual([
      { id: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5' },
      { id: 'claude-opus-4-1', displayName: 'Opus 4.1' },
    ]);
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

  it('re-checks eligibility on the server, never forces, keeps branches and audits each removal', async () => {
    const project = await insertProject();
    const database = await db();
    const [clean] = await database.insert(worktrees).values({ projectId: project.id, name: 'contrastes', branch: 'feature/contrastes', path: '/srv/dev/.w/contrastes' }).returning();
    const [dirty] = await database.insert(worktrees).values({ projectId: project.id, name: 'galerie', branch: 'feature/galerie', path: '/srv/dev/.w/galerie' }).returning();
    const [raced] = await database.insert(worktrees).values({ projectId: project.id, name: 'course', branch: 'feature/course', path: '/srv/dev/.w/course' }).returning();
    const old = new Date(Date.now() - 45 * DAY).toISOString();
    // An old session in this worktree: still inactive (the runner then finds it dirty on removal).
    await database.insert(sessions).values({ id: randomUUID(), projectId: project.id, worktreeId: raced!.id, title: 'x', lastActivityAt: new Date(Date.now() - 50 * DAY) });
    runnerMock.listWorktrees.mockResolvedValue({
      worktrees: [
        dto({ id: clean!.id, projectId: project.id, name: 'contrastes', createdAt: old }),
        dto({ id: dirty!.id, projectId: project.id, name: 'galerie', createdAt: old, dirtyFiles: 3 }),
        dto({ id: raced!.id, projectId: project.id, name: 'course', createdAt: old }),
      ],
    });
    const { RunnerError } = await import('@/server/runner/errors');
    runnerMock.removeWorktree.mockImplementation(async ({ params }: { params: { worktreeId: string } }) => {
      if (params.worktreeId === raced!.id) throw new RunnerError('CONFLICT', 'Modifications non commitées.', { reason: 'WORKTREE_DIRTY' });
      return { operationId: null, removed: true, branchDeleted: false };
    });

    const { listStaleWorktrees, removeStaleWorktrees } = await import('./index');
    const view = await listStaleWorktrees();
    expect(view.staleDays).toBe(30);
    expect(view.items.filter((item) => item.eligible).map((item) => item.name).sort()).toEqual(['contrastes', 'course']);

    const result = await removeStaleWorktrees({ ids: [clean!.id, dirty!.id, raced!.id, '00000000-0000-4000-8000-00000000ffff'] }, { id: TEST_USER_ID });
    expect(result.removed).toEqual([{ id: clean!.id, name: 'contrastes' }]);
    expect(result.skipped.map((item) => [item.name, item.reason])).toEqual([
      ['galerie', '3 fichiers non commités'],
      ['course', 'des modifications non commitées sont apparues'],
      ['00000000', "n'est plus inactif ou n'existe plus"],
    ]);
    for (const call of runnerMock.removeWorktree.mock.calls) expect(call[0].query).toEqual({ force: false, deleteBranch: false });
    const audits = await database.select().from(auditLog).where(eq(auditLog.action, 'maintenance.worktree_removed'));
    expect(audits.map((row) => row.summary)).toEqual(['worktree inactif contrastes (feature/contrastes) supprimé de Devis Express, branche conservée']);
    await expect(removeStaleWorktrees({ ids: [] }, { id: TEST_USER_ID })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('reports the runner as unavailable instead of an empty list', async () => {
    await insertProject();
    const { RunnerError } = await import('@/server/runner/errors');
    runnerMock.listWorktrees.mockRejectedValue(new RunnerError('RUNNER_UNAVAILABLE', 'VPS-3 ne répond pas.'));
    const { listStaleWorktrees, load } = await import('./index');
    const result = await load(() => listStaleWorktrees());
    expect(result).toMatchObject({ ok: false, error: { unavailable: true } });
  });
});

describe('journaux', () => {
  it('lists operations with their status and serves one journal on demand', async () => {
    const project = await insertProject();
    const [op] = await (await db())
      .insert(operations)
      .values({ kind: 'pull', status: 'failed', projectId: project.id, title: 'origin/main', log: 'fetch…\n', error: { code: 'X', message: 'délai dépassé', raw: 'fatal: timeout' } })
      .returning();
    const { listOperationLogs, getOperationLog } = await import('./index');
    const items = await listOperationLogs();
    expect(items).toEqual([expect.objectContaining({ id: op!.id, kind: 'pull', status: 'failed', projectName: 'Devis Express', errorMessage: 'délai dépassé', hasLog: true })]);
    expect(await getOperationLog(op!.id)).toEqual({ log: 'fetch…\n', raw: 'fatal: timeout' });
    await expect(getOperationLog('nope')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('Claude CLI', () => {
  it('keeps only the whitelisted fields of claude auth status', async () => {
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
    const view = await getClaudeCli({ refresh: true });
    expect(runnerMock.claudeStatus).toHaveBeenCalledWith({ query: { refresh: true } }, {});
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
});
