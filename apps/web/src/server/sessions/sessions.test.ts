import { auditLog, projectEnvVars, projects, sessions, worktrees } from '@nuera/db/schema';
import type { SessionDto } from '@nuera/shared/runner';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerClient } from '@/server/runner/client';
import { closeSessionsTestDb, prepareSessionsTestDatabase, resetSessionTables, TEST_USER_ID } from './test/db';

// --- fake runner (the real HTTP client is replaced; its error classes are kept) -----------------
const runnerMock = {
  listSessions: vi.fn<RunnerClient['listSessions']>(),
  getSession: vi.fn<RunnerClient['getSession']>(),
  listBranches: vi.fn<RunnerClient['listBranches']>(),
  createSession: vi.fn<RunnerClient['createSession']>(),
  sendInstruction: vi.fn<RunnerClient['sendInstruction']>(),
  resumeSession: vi.fn<RunnerClient['resumeSession']>(),
  stopSession: vi.fn<RunnerClient['stopSession']>(),
  worktreeChanges: vi.fn<RunnerClient['worktreeChanges']>(),
};
vi.mock('@/server/runner/client', async () => {
  const errors = await import('@/server/runner/errors');
  return { ...errors, runner: runnerMock };
});
vi.mock('@/server/mcp', () => ({
  buildSessionMcpConfig: vi.fn<() => Promise<unknown>>(async () => ({
    mcpConfig: { mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: 'nuera' } } },
    denyRules: ['mcp__coolify__deploy'],
    env: { ENABLE_TOOL_SEARCH: 'true' },
    skipped: [],
  })),
}));

const actor = { id: TEST_USER_ID };

beforeAll(async () => {
  await prepareSessionsTestDatabase('service');
});
afterAll(async () => {
  await closeSessionsTestDb();
});
beforeEach(async () => {
  await resetSessionTables();
  for (const fn of Object.values(runnerMock)) fn.mockReset();
  runnerMock.listSessions.mockResolvedValue({ sessions: [], capacity: { live: 0, max: 4 } });
});

async function db() {
  return (await import('@/server/db')).db;
}

async function createProject(overrides: Partial<typeof projects.$inferInsert> = {}) {
  const [project] = await (await db())
    .insert(projects)
    .values({
      slug: 'devis-express',
      name: 'Devis Express',
      githubFullName: 'atelier-test/devis-express',
      cloneUrl: 'https://github.com/atelier-test/devis-express.git',
      path: '/srv/dev/devis-express',
      status: 'ready',
      ...overrides,
    })
    .returning();
  return project!;
}

async function createWorktree(projectId: string, name: string, branch: string, overrides: Partial<typeof worktrees.$inferInsert> = {}) {
  const [row] = await (await db())
    .insert(worktrees)
    .values({ projectId, name, branch, path: `/srv/dev/.worktrees/devis-express/${name}`, status: 'active', ...overrides })
    .returning();
  return row!;
}

async function createSessionRow(projectId: string, worktreeId: string | null, overrides: Partial<typeof sessions.$inferInsert> = {}) {
  const [row] = await (await db())
    .insert(sessions)
    .values({ id: crypto.randomUUID(), projectId, worktreeId, title: 'Session', status: 'finished', ...overrides })
    .returning();
  return row!;
}

function dto(partial: Partial<SessionDto> & { id: string; projectId: string }): SessionDto {
  return {
    worktreeId: null,
    title: 'Session',
    status: 'new',
    backend: 'pty',
    tmuxName: null,
    permissionMode: 'manual',
    model: null,
    effort: null,
    remoteControl: false,
    remoteControlUrl: null,
    live: false,
    resumable: false,
    pid: null,
    terminalId: null,
    lastInstruction: null,
    currentActivity: null,
    planDone: null,
    planTotal: null,
    cliStatus: null,
    pendingPermission: null,
    queuedInstructions: 0,
    errorCode: null,
    errorMessage: null,
    exitCode: null,
    resumeCount: 0,
    startedAt: null,
    endedAt: null,
    lastActivityAt: null,
    createdAt: new Date().toISOString(),
    worktree: null,
    ...partial,
  };
}

type Branch = Awaited<ReturnType<RunnerClient['listBranches']>>['branches'][number];
const branch = (name: string, extra: Partial<Branch> = {}): Branch => ({
  name,
  kind: 'local',
  remote: null,
  current: false,
  headSha: 'a'.repeat(40),
  subject: 'x',
  committedAt: null,
  upstream: null,
  ahead: null,
  behind: null,
  merged: false,
  protected: false,
  isDefault: name === 'main',
  worktreeId: null,
  worktreeName: null,
  sessionId: null,
  ...extra,
});

describe('createSession', () => {
  it('creates a new branch worktree through the runner with the launch options, audits it and sends the first instruction', async () => {
    const { encryptSecret } = await import('@/server/security/crypto');
    const project = await createProject();
    await (await db()).insert(projectEnvVars).values([
      { projectId: project.id, key: 'STRIPE_KEY', valueEncrypted: encryptSecret('sk_test_123'), isSecret: true },
      { projectId: project.id, key: 'GITHUB_TOKEN', valueEncrypted: encryptSecret('ghp_secret'), isSecret: true },
      { projectId: project.id, key: 'DATABASE_URL', valueEncrypted: encryptSecret('postgres://x'), isSecret: true },
    ]);
    runnerMock.listBranches.mockResolvedValue({ defaultBranch: 'main', branches: [branch('main', { current: true })] });
    const sessionId = crypto.randomUUID();
    runnerMock.createSession.mockImplementation(async ({ body }) =>
      dto({ id: sessionId, projectId: body.projectId, title: body.title, worktree: { id: crypto.randomUUID(), name: 'export-pdf', branch: 'feature/export-pdf', baseBranch: 'main', path: '/x', isPrimary: false } }),
    );
    runnerMock.sendInstruction.mockResolvedValue({ delivered: false, queued: true, started: true, resumed: false, session: dto({ id: sessionId, projectId: project.id }) });

    const { createSession } = await import('./index');
    const result = await createSession(
      { projectId: project.id, title: 'Export PDF', branch: { mode: 'new', branch: 'feature/export-pdf' }, instruction: 'Lis CLAUDE.md' },
      actor,
    );

    expect(result).toEqual({ sessionId, workspaceUrl: `/workspace/${sessionId}`, instruction: 'queued', instructionError: null });
    const body = runnerMock.createSession.mock.calls[0]![0].body;
    expect(body.worktree).toEqual({ mode: 'new', branch: 'feature/export-pdf', base: 'main' });
    expect(body.permissionMode).toBe('manual');
    expect(body.start).toBe(false);
    expect(body.createdByUserId).toBe(TEST_USER_ID);
    expect(body.launch).toMatchObject({
      env: { STRIPE_KEY: 'sk_test_123', ENABLE_TOOL_SEARCH: 'true' },
      denyRules: ['mcp__coolify__deploy'],
      mcpConfig: { mcpServers: { github: { headersHelper: 'nuera' } } },
      maxConcurrentSessions: 4,
    });
    expect(Object.keys(body.launch?.env ?? {})).toEqual(['STRIPE_KEY', 'ENABLE_TOOL_SEARCH']);
    expect(runnerMock.sendInstruction).toHaveBeenCalledWith({ params: { sessionId }, body: { text: 'Lis CLAUDE.md' } });

    const audits = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'session.create'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.summary).toBe('session créée : « Export PDF » · Devis Express · feature/export-pdf');
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain('sk_test_123');
  });

  it('refuses at capacity, a branch that already exists and the bypass mode while it is blocked', async () => {
    const project = await createProject();
    const { createSession } = await import('./index');
    runnerMock.listSessions.mockResolvedValue({ sessions: [], capacity: { live: 4, max: 4 } });
    await expect(createSession({ projectId: project.id, branch: { mode: 'primary' } }, actor)).rejects.toMatchObject({
      code: 'CONFLICT',
      reason: 'CAPACITY_REACHED',
      message: "4 sessions actives sur 4 autorisées : arrêtez-en une avant d'en démarrer une autre.",
    });

    runnerMock.listSessions.mockResolvedValue({ sessions: [], capacity: { live: 0, max: 4 } });
    runnerMock.listBranches.mockResolvedValue({ defaultBranch: 'main', branches: [branch('main'), branch('feature/x')] });
    await expect(createSession({ projectId: project.id, branch: { mode: 'new', branch: 'feature/x' } }, actor)).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(createSession({ projectId: project.id, branch: { mode: 'primary' }, permissionMode: 'bypassPermissions' }, actor)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(createSession({ projectId: project.id, branch: { mode: 'new', branch: 'bad name' } }, actor)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(runnerMock.createSession).not.toHaveBeenCalled();
  });

  it('reuses the worktree of an existing branch, refuses one with a live session, and keeps a failed instruction as data', async () => {
    const project = await createProject();
    const worktreeId = crypto.randomUUID();
    runnerMock.listBranches.mockResolvedValue({
      defaultBranch: 'main',
      branches: [branch('main', { current: true }), branch('feature/a', { worktreeId, worktreeName: 'a' }), branch('feature/b', { worktreeId: crypto.randomUUID(), sessionId: crypto.randomUUID() }), branch('feature/c', { kind: 'remote', remote: 'origin' })],
    });
    const sessionId = crypto.randomUUID();
    runnerMock.createSession.mockResolvedValue(dto({ id: sessionId, projectId: project.id }));
    runnerMock.sendInstruction.mockRejectedValue(Object.assign(new (await import('@/server/errors')).AppError('CONFLICT', "Répondez d'abord à la demande d'autorisation.")));
    const { createSession } = await import('./index');

    await createSession({ projectId: project.id, branch: { mode: 'existing', branch: 'feature/a' } }, actor);
    expect(runnerMock.createSession.mock.calls[0]![0].body.worktree).toEqual({ mode: 'existing', worktreeId });
    await createSession({ projectId: project.id, branch: { mode: 'existing', branch: 'main' } }, actor);
    expect(runnerMock.createSession.mock.calls[1]![0].body.worktree).toEqual({ mode: 'primary' });
    const failed = await createSession({ projectId: project.id, branch: { mode: 'existing', branch: 'feature/c' }, instruction: 'Go' }, actor);
    expect(runnerMock.createSession.mock.calls[2]![0].body.worktree).toEqual({ mode: 'new', branch: 'feature/c' });
    expect(failed.instruction).toBe('failed');
    expect(failed.instructionError?.message).toBe("Répondez d'abord à la demande d'autorisation.");
    await expect(createSession({ projectId: project.id, branch: { mode: 'existing', branch: 'feature/b' } }, actor)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('archive, rename, stop, resume', () => {
  it('archives a stopped session (never a live one), renames with an audit, stops only what runs', async () => {
    const project = await createProject();
    const wt = await createWorktree(project.id, 'a', 'feature/a');
    const stopped = await createSessionRow(project.id, wt.id, { status: 'stopped', title: 'Arrêtée' });
    const running = await createSessionRow(project.id, wt.id, { status: 'running', title: 'Vivante' });
    runnerMock.getSession.mockImplementation(async ({ params }) =>
      dto({ id: params.sessionId, projectId: project.id, status: params.sessionId === running.id ? 'running' : 'stopped', live: params.sessionId === running.id }),
    );
    const { archiveSession, renameSession, stopSession } = await import('./index');

    await expect(archiveSession(running.id, actor)).rejects.toMatchObject({ code: 'CONFLICT' });
    const archived = await archiveSession(stopped.id, actor);
    expect(archived.session.status).toBe('stopped'); // runner view in the mock; the row is archived:
    const [row] = await (await db()).select().from(sessions).where(eq(sessions.id, stopped.id));
    expect(row!.status).toBe('archived');
    expect(row!.archivedAt).not.toBeNull();

    await renameSession(stopped.id, '  Export CSV  ', actor);
    const [renamed] = await (await db()).select().from(sessions).where(eq(sessions.id, stopped.id));
    expect(renamed!.title).toBe('Export CSV');
    await expect(renameSession(stopped.id, '   ', actor)).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(stopSession(stopped.id, actor)).rejects.toMatchObject({ code: 'CONFLICT' });
    runnerMock.stopSession.mockResolvedValue(dto({ id: running.id, projectId: project.id, status: 'stopped', title: 'Vivante' }));
    await stopSession(running.id, actor);
    expect(runnerMock.stopSession).toHaveBeenCalledWith({ params: { sessionId: running.id }, body: { force: false } });

    const actions = (await (await db()).select().from(auditLog)).map((a) => a.action).sort();
    expect(actions).toEqual(['session.archive', 'session.rename', 'session.stop']);
  });

  it('resumes with rebuilt launch options and refuses an archived session', async () => {
    const project = await createProject();
    const wt = await createWorktree(project.id, 'a', 'feature/a');
    const interrupted = await createSessionRow(project.id, wt.id, { status: 'interrupted', transcriptPath: '/home/x.jsonl' });
    const archived = await createSessionRow(project.id, wt.id, { status: 'archived' });
    runnerMock.getSession.mockResolvedValue(dto({ id: interrupted.id, projectId: project.id, status: 'interrupted', resumable: true }));
    runnerMock.resumeSession.mockResolvedValue(dto({ id: interrupted.id, projectId: project.id, status: 'running', live: true, resumeCount: 1 }));
    const { resumeSession } = await import('./index');
    const result = await resumeSession(interrupted.id, actor);
    expect(result.workspaceUrl).toBe(`/workspace/${interrupted.id}`);
    expect(runnerMock.resumeSession.mock.calls[0]![0].body?.launch).toMatchObject({ denyRules: ['mcp__coolify__deploy'] });
    await expect(resumeSession(archived.id, actor)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('listSessions / getCapacity', () => {
  it('filters the history, paginates by cursor and confirms « reprise possible » with the runner', async () => {
    const project = await createProject();
    const wt = await createWorktree(project.id, 'a', 'feature/a');
    const gone = await createWorktree(project.id, 'b', 'feature/b', { status: 'removed', removedAt: new Date() });
    const base = Date.now() - 3 * 86_400_000;
    const at = (h: number) => new Date(base + h * 3_600_000);
    const finished = await createSessionRow(project.id, wt.id, { status: 'finished', title: 'Galerie photos', startedAt: at(5), endedAt: at(6) });
    const resumable = await createSessionRow(project.id, wt.id, { status: 'interrupted', title: 'Correctif tarifs', transcriptPath: '/t.jsonl', startedAt: at(4), endedAt: at(5) });
    const lost = await createSessionRow(project.id, wt.id, { status: 'interrupted', title: 'Journal perdu', transcriptPath: '/lost.jsonl', startedAt: at(3) });
    const removed = await createSessionRow(project.id, gone.id, { status: 'stopped', title: 'Audit 100% contrastes', transcriptPath: '/c.jsonl', startedAt: at(2) });
    await createSessionRow(project.id, wt.id, { status: 'archived', title: 'Migration', startedAt: at(1) });
    await createSessionRow(project.id, wt.id, { status: 'finished', title: 'Ancienne', startedAt: new Date(Date.now() - 60 * 86_400_000) });
    await createSessionRow(project.id, wt.id, { status: 'running', title: 'En cours', startedAt: at(7) });
    runnerMock.getSession.mockImplementation(async ({ params }) =>
      dto({ id: params.sessionId, projectId: project.id, status: 'interrupted', resumable: params.sessionId === resumable.id }),
    );
    const { listSessions, getCapacity } = await import('./index');

    const all = await listSessions({ status: 'history' });
    expect(all.items.map((i) => i.title)).toEqual(['Galerie photos', 'Correctif tarifs', 'Journal perdu', 'Audit 100% contrastes', 'Migration']);
    expect(all.items[0]!.durationMs).toBe(3_600_000);
    expect(all.items.find((i) => i.id === removed.id)?.resumeBlockedReason).toBe('worktree_removed');
    expect(all.items.find((i) => i.id === lost.id)).toMatchObject({ resumable: false, resumeBlockedReason: 'not_recorded' });
    expect(all.verified).toBe(true);

    expect((await listSessions({ status: 'history', filter: 'reprise-possible' })).items.map((i) => i.id)).toEqual([resumable.id]);
    // « Journal perdu »: recorded in the database, but the runner no longer finds its journal.
    expect((await listSessions({ status: 'history', filter: 'reprise-impossible' })).items.map((i) => i.id)).toEqual([lost.id, removed.id]);
    // Post-filtered pages are filled from the following rows, and the cursor resumes after the last row read.
    const firstImpossible = await listSessions({ status: 'history', filter: 'reprise-impossible', limit: 1 });
    expect(firstImpossible.items.map((i) => i.id)).toEqual([lost.id]);
    const next = await listSessions({ status: 'history', filter: 'reprise-impossible', limit: 1, cursor: firstImpossible.nextCursor });
    expect(next.items.map((i) => i.id)).toEqual([removed.id]);
    expect(next.nextCursor).toBeNull();
    const onlyResumable = await listSessions({ status: 'history', filter: 'reprise-possible', limit: 1 });
    expect(onlyResumable.items.map((i) => i.id)).toEqual([resumable.id]);
    expect((await listSessions({ status: 'history', filter: 'terminees', period: 'tout' })).items).toHaveLength(2);
    expect((await listSessions({ status: 'history', q: '100%' })).items.map((i) => i.id)).toEqual([removed.id]);
    expect((await listSessions({ status: 'history', q: 'feature/b' })).items.map((i) => i.id)).toEqual([removed.id]);

    const first = await listSessions({ status: 'history', limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual([finished.id, resumable.id]);
    const second = await listSessions({ status: 'history', limit: 2, cursor: first.nextCursor });
    expect(second.items.map((i) => i.title)).toEqual(['Journal perdu', 'Audit 100% contrastes']);
    const third = await listSessions({ status: 'history', limit: 2, cursor: second.nextCursor });
    expect(third.items.map((i) => i.title)).toEqual(['Migration']);
    expect(third.nextCursor).toBeNull();
    await expect(listSessions({ status: 'history', cursor: 'nope' })).rejects.toMatchObject({ code: 'VALIDATION' });

    const active = await listSessions({ status: 'active' });
    expect(active.items.map((i) => i.title)).toEqual(['En cours']);

    runnerMock.listSessions.mockResolvedValue({ sessions: [], capacity: { live: 2, max: 4 } });
    expect(await getCapacity()).toEqual({ active: 2, max: 4, source: 'runner' });
  });

  it('falls back to the database when the runner does not answer', async () => {
    const project = await createProject();
    const wt = await createWorktree(project.id, 'a', 'feature/a');
    await createSessionRow(project.id, wt.id, { status: 'running', title: 'Vivante', startedAt: new Date() });
    await createSessionRow(project.id, wt.id, { status: 'interrupted', title: 'Reprenable', transcriptPath: '/t.jsonl', startedAt: new Date() });
    const { RunnerError } = await import('@/server/runner/errors');
    const down = new RunnerError('RUNNER_UNAVAILABLE', 'VPS-3 ne répond pas : le runner est injoignable.');
    runnerMock.listSessions.mockRejectedValue(down);
    runnerMock.getSession.mockRejectedValue(down);
    const { listSessions, getCapacity } = await import('./index');
    expect(await getCapacity()).toEqual({ active: 1, max: 4, source: 'database' });
    const history = await listSessions({ status: 'history' });
    expect(history.verified).toBe(false);
    expect(history.items[0]).toMatchObject({ title: 'Reprenable', resumable: true });
    const active = await listSessions({ status: 'active' });
    expect(active).toMatchObject({ verified: false });
    expect(active.items[0]).toMatchObject({ title: 'Vivante', live: true });
  });
});
