import { appSettings, auditLog, projectEnvVars, projects, sessions, spaceSettings, userPreferences, worktrees } from '@nuera/db/schema';
import type { SessionDto } from '@nuera/shared/runner';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerClient } from '@/server/runner/client';
import { closeSessionsTestDb, prepareSessionsTestDatabase, resetSessionTables, testContext, TEST_ENVIRONMENT_ID, TEST_SPACE_ID, TEST_USER_ID } from './test/db';

// --- fake runner (the per-server client is replaced; its error classes are kept) ---------------
const runnerMock = {
  listSessions: vi.fn<RunnerClient['listSessions']>(),
  getSession: vi.fn<RunnerClient['getSession']>(),
  listBranches: vi.fn<RunnerClient['listBranches']>(),
  createSession: vi.fn<RunnerClient['createSession']>(),
  sendInstruction: vi.fn<RunnerClient['sendInstruction']>(),
  resumeSession: vi.fn<RunnerClient['resumeSession']>(),
  startSession: vi.fn<RunnerClient['startSession']>(),
  stopSession: vi.fn<RunnerClient['stopSession']>(),
  worktreeChanges: vi.fn<RunnerClient['worktreeChanges']>(),
  announceSession: vi.fn<RunnerClient['announceSession']>(),
  setSessionAutoResume: vi.fn<RunnerClient['setSessionAutoResume']>(),
};
/** Server whose client each call asked for (the runner of the server holding the resource). */
const servers = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock('@/server/runner/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/runner/client')>();
  return {
    ...original,
    getRunnerForEnvironment: (environmentId: string) => {
      servers.asked.push(environmentId);
      return runnerMock;
    },
  };
});
vi.mock('@/server/mcp', () => ({
  buildSessionMcpConfig: vi.fn<() => Promise<unknown>>(async () => ({
    mcpConfig: { mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headersHelper: 'nuera' } } },
    denyRules: ['mcp__coolify__deploy'],
    allowRules: [],
    askRules: [],
    blockBypass: false,
    env: { ENABLE_TOOL_SEARCH: 'true' },
    skipped: [],
  })),
}));

const ctx = testContext();

beforeAll(async () => {
  await prepareSessionsTestDatabase('service');
});
afterAll(async () => {
  await closeSessionsTestDb();
});
beforeEach(async () => {
  await resetSessionTables();
  for (const fn of Object.values(runnerMock)) fn.mockReset();
  servers.asked.length = 0;
  runnerMock.listSessions.mockResolvedValue({ sessions: [], capacity: { live: 0, max: 4 } });
});

async function db() {
  return (await import('@/server/db')).db;
}

async function createProject(overrides: Partial<typeof projects.$inferInsert> = {}) {
  const [project] = await (await db())
    .insert(projects)
    .values({
      spaceId: TEST_SPACE_ID,
      environmentId: TEST_ENVIRONMENT_ID,
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
    .values({ projectId, environmentId: TEST_ENVIRONMENT_ID, name, branch, path: `/srv/dev/.worktrees/devis-express/${name}`, status: 'active', ...overrides })
    .returning();
  return row!;
}

async function createSessionRow(projectId: string, worktreeId: string | null, overrides: Partial<typeof sessions.$inferInsert> = {}) {
  const [row] = await (await db())
    .insert(sessions)
    .values({ id: crypto.randomUUID(), projectId, environmentId: TEST_ENVIRONMENT_ID, worktreeId, title: 'Session', status: 'finished', ...overrides })
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
  it('creates a new branch worktree on the project server with the launch options, audits it and sends the first instruction', async () => {
    const { encryptSecret, SecretScopes } = await import('@/server/security/crypto');
    const project = await createProject();
    await (await db()).insert(projectEnvVars).values([
      { projectId: project.id, key: 'STRIPE_KEY', valueEncrypted: encryptSecret('sk_test_123', SecretScopes.projectEnvVar(project.id, 'STRIPE_KEY')), isSecret: true },
      { projectId: project.id, key: 'GITHUB_TOKEN', valueEncrypted: encryptSecret('ghp_secret', SecretScopes.projectEnvVar(project.id, 'GITHUB_TOKEN')), isSecret: true },
      { projectId: project.id, key: 'DATABASE_URL', valueEncrypted: encryptSecret('postgres://x', SecretScopes.projectEnvVar(project.id, 'DATABASE_URL')), isSecret: true },
    ]);
    runnerMock.listBranches.mockResolvedValue({ defaultBranch: 'main', branches: [branch('main', { current: true })] });
    const sessionId = crypto.randomUUID();
    runnerMock.createSession.mockImplementation(async ({ body }) =>
      dto({ id: sessionId, projectId: body.projectId, title: body.title, worktree: { id: crypto.randomUUID(), name: 'export-pdf', branch: 'feature/export-pdf', baseBranch: 'main', path: '/x', isPrimary: false } }),
    );
    runnerMock.sendInstruction.mockResolvedValue({ delivered: false, queued: true, started: true, resumed: false, session: dto({ id: sessionId, projectId: project.id }) });

    const { createSession } = await import('./index');
    const result = await createSession(ctx, { projectId: project.id, title: 'Export PDF', branch: { mode: 'new', branch: 'feature/export-pdf' }, instruction: 'Lis CLAUDE.md' });

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
      // Effective policy of the space (defaults) and the account's Git identity.
      permissionWaitSeconds: 120,
      blockBypassPermissions: true,
      gitIdentity: { name: 'Camille Laurent', email: 'owner@example.test' },
    });
    // The limits of the server are the runner's own (its `environments` row): none is sent.
    expect(body.launch).not.toHaveProperty('maxConcurrentSessions');
    expect(body.launch).not.toHaveProperty('memoryLimitMb');
    expect(Object.keys(body.launch?.env ?? {})).toEqual(['STRIPE_KEY', 'ENABLE_TOOL_SEARCH']);
    expect(runnerMock.sendInstruction).toHaveBeenCalledWith({ params: { sessionId }, body: { text: 'Lis CLAUDE.md' } });
    // Every runner call went to the server holding the project.
    expect(new Set(servers.asked)).toEqual(new Set([TEST_ENVIRONMENT_ID]));

    const audits = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'session.create'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.summary).toBe('session créée : « Export PDF » · Devis Express · feature/export-pdf');
    expect(audits[0]).toMatchObject({ actorUserId: TEST_USER_ID, spaceId: TEST_SPACE_ID, environmentId: TEST_ENVIRONMENT_ID, actorLabel: 'owner@example.test' });
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain('sk_test_123');
  });

  it('takes the defaults and the policy of the space, and the Git identity chosen in Paramètres', async () => {
    const project = await createProject();
    await (await db())
      .update(spaceSettings)
      .set({ defaultModel: 'opus', defaultEffort: 'high', permissionWaitSeconds: 300, remoteControlByDefault: true, blockBypassPermissions: false, defaultPermissionMode: 'acceptEdits' })
      .where(eq(spaceSettings.spaceId, TEST_SPACE_ID));
    await (await db())
      .update(userPreferences)
      .set({ gitAuthorName: 'Camille L.', gitAuthorEmail: 'camille@atelier.test' })
      .where(eq(userPreferences.userId, TEST_USER_ID));
    const { invalidateSettingsCache } = await import('@/server/settings');
    invalidateSettingsCache();
    runnerMock.createSession.mockImplementation(async ({ body }) => dto({ id: crypto.randomUUID(), projectId: body.projectId }));
    const { createSession } = await import('./index');
    await createSession(ctx, { projectId: project.id, branch: { mode: 'primary' } });
    const body = runnerMock.createSession.mock.calls[0]![0].body;
    expect(body).toMatchObject({ model: 'opus', effort: 'high', remoteControl: true, permissionMode: 'acceptEdits' });
    expect(body.launch).toMatchObject({ permissionWaitSeconds: 300, blockBypassPermissions: false, gitIdentity: { name: 'Camille L.', email: 'camille@atelier.test' } });
    // The bypass mode is allowed once the space no longer blocks it.
    await createSession(ctx, { projectId: project.id, branch: { mode: 'primary' }, permissionMode: 'bypassPermissions' });
    expect(runnerMock.createSession.mock.calls[1]![0].body.permissionMode).toBe('bypassPermissions');
  });

  it('sends the block forced by the instance even when the space allows the bypass mode', async () => {
    const project = await createProject();
    const { getInstanceSettings, invalidateSettingsCache } = await import('@/server/settings');
    await getInstanceSettings();
    await (await db()).update(appSettings).set({ forceBlockBypassPermissions: true }).where(eq(appSettings.id, 1));
    await (await db()).update(spaceSettings).set({ blockBypassPermissions: false }).where(eq(spaceSettings.spaceId, TEST_SPACE_ID));
    invalidateSettingsCache();
    runnerMock.createSession.mockImplementation(async ({ body }) => dto({ id: crypto.randomUUID(), projectId: body.projectId }));
    const { createSession } = await import('./index');
    await createSession(ctx, { projectId: project.id, branch: { mode: 'primary' } });
    expect(runnerMock.createSession.mock.calls[0]![0].body.launch).toMatchObject({ blockBypassPermissions: true });
    await expect(createSession(ctx, { projectId: project.id, branch: { mode: 'primary' }, permissionMode: 'bypassPermissions' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(runnerMock.createSession).toHaveBeenCalledTimes(1);
  });

  it('refuses at capacity, a branch that already exists and the bypass mode while it is blocked', async () => {
    const project = await createProject();
    const { createSession } = await import('./index');
    runnerMock.listSessions.mockResolvedValue({ sessions: [], capacity: { live: 4, max: 4 } });
    await expect(createSession(ctx, { projectId: project.id, branch: { mode: 'primary' } })).rejects.toMatchObject({
      code: 'CONFLICT',
      reason: 'CAPACITY_REACHED',
      message: "4 sessions actives sur 4 autorisées : arrêtez-en une avant d'en démarrer une autre.",
    });

    runnerMock.listSessions.mockResolvedValue({ sessions: [], capacity: { live: 0, max: 4 } });
    runnerMock.listBranches.mockResolvedValue({ defaultBranch: 'main', branches: [branch('main'), branch('feature/x')] });
    await expect(createSession(ctx, { projectId: project.id, branch: { mode: 'new', branch: 'feature/x' } })).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(createSession(ctx, { projectId: project.id, branch: { mode: 'primary' }, permissionMode: 'bypassPermissions' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(createSession(ctx, { projectId: project.id, branch: { mode: 'new', branch: 'bad name' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(runnerMock.createSession).not.toHaveBeenCalled();
  });

  it('counts the capacity against the limit of the project server', async () => {
    const project = await createProject();
    const { environments } = await import('@nuera/db/schema');
    await (await db()).update(environments).set({ maxConcurrentSessions: 2 }).where(eq(environments.id, TEST_ENVIRONMENT_ID));
    const { invalidateSettingsCache } = await import('@/server/settings');
    invalidateSettingsCache();
    runnerMock.listSessions.mockResolvedValue({ sessions: [], capacity: { live: 2, max: 4 } });
    const { createSession } = await import('./index');
    await expect(createSession(ctx, { projectId: project.id, branch: { mode: 'primary' } })).rejects.toMatchObject({
      reason: 'CAPACITY_REACHED',
      message: "2 sessions actives sur 2 autorisées : arrêtez-en une avant d'en démarrer une autre.",
    });
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

    await createSession(ctx, { projectId: project.id, branch: { mode: 'existing', branch: 'feature/a' } });
    expect(runnerMock.createSession.mock.calls[0]![0].body.worktree).toEqual({ mode: 'existing', worktreeId });
    await createSession(ctx, { projectId: project.id, branch: { mode: 'existing', branch: 'main' } });
    expect(runnerMock.createSession.mock.calls[1]![0].body.worktree).toEqual({ mode: 'primary' });
    const failed = await createSession(ctx, { projectId: project.id, branch: { mode: 'existing', branch: 'feature/c' }, instruction: 'Go' });
    expect(runnerMock.createSession.mock.calls[2]![0].body.worktree).toEqual({ mode: 'new', branch: 'feature/c' });
    expect(failed.instruction).toBe('failed');
    expect(failed.instructionError?.message).toBe("Répondez d'abord à la demande d'autorisation.");
    await expect(createSession(ctx, { projectId: project.id, branch: { mode: 'existing', branch: 'feature/b' } })).rejects.toMatchObject({ code: 'CONFLICT' });
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

    await expect(archiveSession(ctx, running.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    const archived = await archiveSession(ctx, stopped.id);
    expect(archived.session.status).toBe('stopped'); // runner view in the mock; the row is archived:
    const [row] = await (await db()).select().from(sessions).where(eq(sessions.id, stopped.id));
    expect(row!.status).toBe('archived');
    expect(row!.archivedAt).not.toBeNull();

    await renameSession(ctx, stopped.id, '  Export CSV  ');
    const [renamed] = await (await db()).select().from(sessions).where(eq(sessions.id, stopped.id));
    expect(renamed!.title).toBe('Export CSV');
    await expect(renameSession(ctx, stopped.id, '   ')).rejects.toMatchObject({ code: 'VALIDATION' });
    // Other tabs follow both changes live (runner `session.status`), once each.
    expect(runnerMock.announceSession.mock.calls.map((call) => call[0])).toEqual([{ params: { sessionId: stopped.id } }, { params: { sessionId: stopped.id } }]);
    // Runner unreachable: the change stays done.
    const { RunnerError } = await import('@/server/runner/errors');
    runnerMock.announceSession.mockRejectedValueOnce(new RunnerError('RUNNER_UNAVAILABLE', 'Le runner ne répond pas.'));
    await renameSession(ctx, stopped.id, 'Export CSV v2');
    const [again] = await (await db()).select().from(sessions).where(eq(sessions.id, stopped.id));
    expect(again!.title).toBe('Export CSV v2');

    await expect(stopSession(ctx, stopped.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    runnerMock.stopSession.mockResolvedValue(dto({ id: running.id, projectId: project.id, status: 'stopped', title: 'Vivante' }));
    await stopSession(ctx, running.id);
    expect(runnerMock.stopSession).toHaveBeenCalledWith({ params: { sessionId: running.id }, body: { force: false } });

    const audits = await (await db()).select().from(auditLog);
    expect(audits.map((a) => a.action).sort()).toEqual(['session.archive', 'session.rename', 'session.rename', 'session.stop']);
    for (const entry of audits) expect(entry).toMatchObject({ spaceId: TEST_SPACE_ID, environmentId: TEST_ENVIRONMENT_ID, actorUserId: TEST_USER_ID });
  });

  it('resumes with launch options rebuilt for the account that resumes, and refuses an archived session', async () => {
    const project = await createProject();
    const wt = await createWorktree(project.id, 'a', 'feature/a');
    const interrupted = await createSessionRow(project.id, wt.id, { status: 'interrupted', transcriptPath: '/home/x.jsonl' });
    const archived = await createSessionRow(project.id, wt.id, { status: 'archived' });
    runnerMock.getSession.mockResolvedValue(dto({ id: interrupted.id, projectId: project.id, status: 'interrupted', resumable: true }));
    runnerMock.resumeSession.mockResolvedValue(dto({ id: interrupted.id, projectId: project.id, status: 'running', live: true, resumeCount: 1 }));
    const { resumeSession } = await import('./index');
    const result = await resumeSession(ctx, interrupted.id);
    expect(result.workspaceUrl).toBe(`/workspace/${interrupted.id}`);
    expect(runnerMock.resumeSession.mock.calls[0]![0].body?.launch).toMatchObject({
      denyRules: ['mcp__coolify__deploy'],
      blockBypassPermissions: true,
      gitIdentity: { name: 'Camille Laurent', email: 'owner@example.test' },
    });
    const [entry] = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'session.resume'));
    expect(entry?.summary).toBe('session reprise : « Session » · Devis Express');
    await expect(resumeSession(ctx, archived.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('starts a session that never ran with the policy of the space (pre-upgrade launch.json without the bypass block)', async () => {
    const project = await createProject();
    const wt = await createWorktree(project.id, 'a', 'feature/a');
    await (await db()).update(spaceSettings).set({ blockBypassPermissions: false, permissionWaitSeconds: 240 }).where(eq(spaceSettings.spaceId, TEST_SPACE_ID));
    const { invalidateSettingsCache } = await import('@/server/settings');
    invalidateSettingsCache();
    const fresh = await createSessionRow(project.id, wt.id, { status: 'new', permissionMode: 'bypassPermissions' });
    const archived = await createSessionRow(project.id, wt.id, { status: 'archived', archivedAt: new Date() });
    runnerMock.startSession.mockResolvedValue(dto({ id: fresh.id, projectId: project.id, status: 'running', live: true }));
    const { startNewSession } = await import('./index');
    await startNewSession(ctx, fresh.id);
    expect(runnerMock.startSession).toHaveBeenCalledTimes(1);
    const call = runnerMock.startSession.mock.calls[0]![0];
    expect(call.params).toEqual({ sessionId: fresh.id });
    expect(call.body?.launch).toMatchObject({
      blockBypassPermissions: false,
      permissionWaitSeconds: 240,
      denyRules: ['mcp__coolify__deploy'],
      gitIdentity: { name: 'Camille Laurent', email: 'owner@example.test' },
    });
    expect(call.body?.launch).not.toHaveProperty('maxConcurrentSessions');
    expect(new Set(servers.asked)).toEqual(new Set([TEST_ENVIRONMENT_ID]));
    await expect(startNewSession(ctx, archived.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(runnerMock.startSession).toHaveBeenCalledTimes(1);
  });
});

describe("reprise automatique après la limite d'utilisation", () => {
  const limit = (scheduled: boolean) => ({
    active: true,
    detectedAt: '2026-11-06T12:40:00.000Z',
    resetsAt: '2026-11-06T14:00:00.000Z',
    source: 'hook',
    window: 'five_hour',
    message: '5-hour limit reached ∙ resets 3pm',
    autoResume: {
      enabled: scheduled,
      nextAttemptAt: scheduled ? '2026-11-06T14:02:00.000Z' : null,
      mode: scheduled ? 'reset' : null,
      attempts: 0,
      maxAttempts: 5,
      lastAttemptAt: null,
      giveUpAt: null,
      outcome: scheduled ? 'scheduled' : 'off',
    },
  });

  it('sends the effective value (session choice, else the space default) at launch and on change, audited', async () => {
    const project = await createProject();
    const wt = await createWorktree(project.id, 'a', 'feature/a');
    await (await db()).update(spaceSettings).set({ autoResumeAfterLimit: true, autoResumeInstruction: 'Reprends les tests.' }).where(eq(spaceSettings.spaceId, TEST_SPACE_ID));
    const { invalidateSettingsCache } = await import('@/server/settings');
    invalidateSettingsCache();
    const row = await createSessionRow(project.id, wt.id, { status: 'waiting_input', usageLimit: limit(true) });
    runnerMock.getSession.mockResolvedValue(dto({ id: row.id, projectId: project.id, status: 'waiting_input', live: true, limit: limit(false) as SessionDto['limit'] }));
    runnerMock.setSessionAutoResume.mockResolvedValue(dto({ id: row.id, projectId: project.id, status: 'waiting_input', live: true }));
    const { setSessionAutoResume, buildLaunchOptions } = await import('./index');

    const result = await setSessionAutoResume(ctx, row.id, false);
    expect(runnerMock.setSessionAutoResume.mock.calls[0]![0]).toMatchObject({ params: { sessionId: row.id }, body: { enabled: false, instruction: 'Reprends les tests.' } });
    expect(result.session).toMatchObject({ autoResume: false, limit: { active: true, autoResume: { outcome: 'off' } } });
    const [stored] = await (await db()).select({ autoResume: sessions.autoResume }).from(sessions).where(eq(sessions.id, row.id));
    expect(stored?.autoResume).toBe(false);
    expect((await buildLaunchOptions(ctx, { projectId: project.id, spaceId: TEST_SPACE_ID }, { autoResume: false })).autoResume).toEqual({ enabled: false, instruction: 'Reprends les tests.' });
    expect((await buildLaunchOptions(ctx, { projectId: project.id, spaceId: TEST_SPACE_ID })).autoResume).toEqual({ enabled: true, instruction: 'Reprends les tests.' });

    // Back to the space default (null): the runner gets the space's value.
    await setSessionAutoResume(ctx, row.id, null);
    expect(runnerMock.setSessionAutoResume.mock.calls[1]![0].body).toEqual({ enabled: true, instruction: 'Reprends les tests.' });
    const entries = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'session.auto_resume_changed'));
    expect(entries.map((e) => e.summary)).toEqual([
      'reprise automatique après la limite : désactivée · « Session »',
      "reprise automatique après la limite : défaut de l'espace (activée) · « Session »",
    ]);
  });

  it('« Reprendre maintenant » types the instruction of the space while the limit stops the session, refused otherwise', async () => {
    const project = await createProject();
    const wt = await createWorktree(project.id, 'a', 'feature/a');
    const limited = await createSessionRow(project.id, wt.id, { status: 'waiting_input', usageLimit: limit(true) });
    const free = await createSessionRow(project.id, wt.id, { status: 'waiting_input' });
    runnerMock.getSession.mockResolvedValue(dto({ id: limited.id, projectId: project.id, status: 'waiting_input', live: true }));
    const { resumeAfterLimitNow } = await import('./index');
    const sent: string[] = [];
    await resumeAfterLimitNow(ctx, limited.id, async (text) => sent.push(text));
    expect(sent).toEqual(["Continue là où tu t'es arrêté."]);
    await expect(resumeAfterLimitNow(ctx, free.id, async (text) => sent.push(text))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(sent).toHaveLength(1);
    const [entry] = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'session.auto_resume_now'));
    expect(entry?.metadata).toMatchObject({ resetsAt: '2026-11-06T14:00:00.000Z', scheduledAt: '2026-11-06T14:02:00.000Z' });
  });

  it('drops the limit with the archive: an archived session never resumes by itself', async () => {
    const project = await createProject();
    const wt = await createWorktree(project.id, 'a', 'feature/a');
    const row = await createSessionRow(project.id, wt.id, { status: 'interrupted', usageLimit: limit(true) });
    runnerMock.getSession.mockResolvedValue(dto({ id: row.id, projectId: project.id, status: 'interrupted' }));
    runnerMock.announceSession.mockResolvedValue(dto({ id: row.id, projectId: project.id, status: 'archived' }));
    const { archiveSession, setSessionAutoResume } = await import('./index');
    const archived = await archiveSession(ctx, row.id);
    expect(archived.session.limit).toBeNull();
    const [stored] = await (await db()).select({ usageLimit: sessions.usageLimit }).from(sessions).where(eq(sessions.id, row.id));
    expect(stored?.usageLimit).toBeNull();
    await expect(setSessionAutoResume(ctx, row.id, true)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(runnerMock.setSessionAutoResume).not.toHaveBeenCalled();
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

    const all = await listSessions(ctx, { status: 'history' });
    expect(all.items.map((i) => i.title)).toEqual(['Galerie photos', 'Correctif tarifs', 'Journal perdu', 'Audit 100% contrastes', 'Migration']);
    expect(all.items[0]!.durationMs).toBe(3_600_000);
    expect(all.items.find((i) => i.id === removed.id)?.resumeBlockedReason).toBe('worktree_removed');
    expect(all.items.find((i) => i.id === lost.id)).toMatchObject({ resumable: false, resumeBlockedReason: 'not_recorded' });
    expect(all.verified).toBe(true);

    expect((await listSessions(ctx, { status: 'history', filter: 'reprise-possible' })).items.map((i) => i.id)).toEqual([resumable.id]);
    // « Journal perdu »: recorded in the database, but the runner no longer finds its journal.
    expect((await listSessions(ctx, { status: 'history', filter: 'reprise-impossible' })).items.map((i) => i.id)).toEqual([lost.id, removed.id]);
    // Post-filtered pages are filled from the following rows, and the cursor resumes after the last row read.
    const firstImpossible = await listSessions(ctx, { status: 'history', filter: 'reprise-impossible', limit: 1 });
    expect(firstImpossible.items.map((i) => i.id)).toEqual([lost.id]);
    const next = await listSessions(ctx, { status: 'history', filter: 'reprise-impossible', limit: 1, cursor: firstImpossible.nextCursor });
    expect(next.items.map((i) => i.id)).toEqual([removed.id]);
    expect(next.nextCursor).toBeNull();
    const onlyResumable = await listSessions(ctx, { status: 'history', filter: 'reprise-possible', limit: 1 });
    expect(onlyResumable.items.map((i) => i.id)).toEqual([resumable.id]);
    expect((await listSessions(ctx, { status: 'history', filter: 'terminees', period: 'tout' })).items).toHaveLength(2);
    expect((await listSessions(ctx, { status: 'history', q: '100%' })).items.map((i) => i.id)).toEqual([removed.id]);
    expect((await listSessions(ctx, { status: 'history', q: 'feature/b' })).items.map((i) => i.id)).toEqual([removed.id]);

    const first = await listSessions(ctx, { status: 'history', limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual([finished.id, resumable.id]);
    const second = await listSessions(ctx, { status: 'history', limit: 2, cursor: first.nextCursor });
    expect(second.items.map((i) => i.title)).toEqual(['Journal perdu', 'Audit 100% contrastes']);
    const third = await listSessions(ctx, { status: 'history', limit: 2, cursor: second.nextCursor });
    expect(third.items.map((i) => i.title)).toEqual(['Migration']);
    expect(third.nextCursor).toBeNull();
    await expect(listSessions(ctx, { status: 'history', cursor: 'nope' })).rejects.toMatchObject({ code: 'VALIDATION' });

    const active = await listSessions(ctx, { status: 'active' });
    expect(active.items.map((i) => i.title)).toEqual(['En cours']);

    runnerMock.listSessions.mockResolvedValue({ sessions: [], capacity: { live: 2, max: 4 } });
    expect(await getCapacity(ctx)).toEqual({ active: 2, max: 4, source: 'runner', environment: { id: TEST_ENVIRONMENT_ID, name: 'VPS-3' } });
  });

  it('offers « Reprendre » for a finished session, like the runner (worktree and journal present)', async () => {
    const project = await createProject();
    const wt = await createWorktree(project.id, 'a', 'feature/a');
    const done = await createSessionRow(project.id, wt.id, { status: 'finished', title: 'Galerie photos', transcriptPath: '/g.jsonl', startedAt: new Date(), endedAt: new Date() });
    runnerMock.getSession.mockImplementation(async ({ params }) => dto({ id: params.sessionId, projectId: project.id, status: 'finished', resumable: true }));
    const { listSessions } = await import('./index');
    const history = await listSessions(ctx, { status: 'history' });
    expect(history.items.find((i) => i.id === done.id)).toMatchObject({ status: 'finished', resumable: true, resumeBlockedReason: null });
    // The « reprise » filters stay about interrupted conversations.
    expect((await listSessions(ctx, { status: 'history', filter: 'reprise-possible' })).items).toHaveLength(0);
    expect((await listSessions(ctx, { status: 'history', filter: 'terminees' })).items.map((i) => i.id)).toEqual([done.id]);
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
    expect(await getCapacity(ctx)).toEqual({ active: 1, max: 4, source: 'database', environment: { id: TEST_ENVIRONMENT_ID, name: 'VPS-3' } });
    const history = await listSessions(ctx, { status: 'history' });
    expect(history.verified).toBe(false);
    expect(history.items[0]).toMatchObject({ title: 'Reprenable', resumable: true });
    const active = await listSessions(ctx, { status: 'active' });
    expect(active).toMatchObject({ verified: false });
    expect(active.items[0]).toMatchObject({ title: 'Vivante', live: true });
  });

  it('degrades to « non vérifié » when the runner is too slow (UPSTREAM), instead of failing the section', async () => {
    const project = await createProject();
    const wt = await createWorktree(project.id, 'a', 'feature/a');
    await createSessionRow(project.id, wt.id, { status: 'running', title: 'Vivante', startedAt: new Date() });
    const stuck = await createSessionRow(project.id, wt.id, { status: 'interrupted', title: 'Reprenable', transcriptPath: '/t.jsonl', startedAt: new Date() });
    const { RunnerError } = await import('@/server/runner/errors');
    const slow = new RunnerError('UPSTREAM', "Le runner n'a pas répondu à temps.", { detail: 'GET /v1/sessions' });
    runnerMock.listSessions.mockRejectedValue(slow);
    runnerMock.getSession.mockRejectedValue(slow);
    const { listSessions, getCapacity, getSessionItem } = await import('./index');
    expect(await getCapacity(ctx)).toMatchObject({ active: 1, source: 'database' });
    const active = await listSessions(ctx, { status: 'active' });
    expect(active).toMatchObject({ verified: false });
    expect(active.items.map((i) => i.title)).toEqual(['Vivante']);
    const history = await listSessions(ctx, { status: 'history' });
    expect(history.verified).toBe(false);
    expect(await getSessionItem(ctx, stuck.id)).toMatchObject({ id: stuck.id, title: 'Reprenable' });
    // Any other runner error still fails (it is not a « cannot verify »).
    runnerMock.listSessions.mockRejectedValue(new RunnerError('FORBIDDEN', 'Refusé.'));
    await expect(listSessions(ctx, { status: 'active' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('says « unassigned » without a server, and offers no new session', async () => {
    const { getCapacity, getNewSessionOptions } = await import('./index');
    const unassigned = { ...ctx, environment: null };
    expect(await getCapacity(unassigned)).toEqual({ active: 0, max: 0, source: 'unassigned', environment: null });
    const options = await getNewSessionOptions(unassigned);
    expect(options).toMatchObject({ environment: null, runnerUnavailable: false, capacity: { source: 'unassigned' } });
    expect(servers.asked).toEqual([]);
  });
});

describe('new-session options', () => {
  it('lists the ready projects of the space with the server name in the reasons, and the defaults of the space', async () => {
    await createProject();
    await createProject({ slug: 'galerie', name: 'Galerie', githubFullName: 'atelier-test/galerie', path: '/srv/dev/galerie', status: 'cloning' });
    await createProject({ slug: 'vieux', name: 'Vieux', githubFullName: 'atelier-test/vieux', path: '/srv/dev/vieux', archivedAt: new Date() });
    const { getNewSessionOptions } = await import('./index');
    const options = await getNewSessionOptions(ctx);
    expect(options.projects.map((p) => [p.name, p.ready, p.unavailableReason])).toEqual([
      ['Devis Express', true, null],
      ['Galerie', false, 'Clonage en cours sur VPS-3.'],
    ]);
    expect(options.defaults).toEqual({ permissionMode: 'manual', model: null, effort: null, remoteControl: false, blockBypassPermissions: true });
    expect(options.environment).toEqual({ id: TEST_ENVIRONMENT_ID, name: 'VPS-3' });
  });
});

describe('isolation between spaces', () => {
  it('answers an id of another space exactly like an unknown id: no runner call, no write, no journal', async () => {
    const { createTestAccount } = await import('@/server/tenancy/test/fixtures');
    const other = await createTestAccount({ role: 'member', name: 'Lou Martin', email: 'lou@example.test' });
    const project = await createProject();
    const wt = await createWorktree(project.id, 'a', 'feature/a');
    const session = await createSessionRow(project.id, wt.id, { status: 'stopped', title: 'Secrète', transcriptPath: '/s.jsonl' });
    const unknownId = crypto.randomUUID();
    const api = await import('./index');
    const b = other.ctx;
    const before = await (await db()).select().from(sessions);
    servers.asked.length = 0;

    const pairs: Array<[string, (id: string) => Promise<unknown>]> = [
      ['createSession', (id) => api.createSession(b, { projectId: id, branch: { mode: 'primary' } })],
      ['getProjectBranchOptions', (id) => api.getProjectBranchOptions(b, id)],
    ];
    for (const [name, call] of pairs) {
      const foreign = await call(project.id).catch((error: unknown) => error);
      const unknown = await call(unknownId).catch((error: unknown) => error);
      expect(foreign, name).toMatchObject({ code: 'NOT_FOUND', message: 'Projet introuvable.' });
      expect(JSON.stringify(foreign), name).toBe(JSON.stringify(unknown));
    }
    const sessionCalls: Array<[string, (id: string) => Promise<unknown>]> = [
      ['getSessionItem', (id) => api.getSessionItem(b, id)],
      ['getSessionSummary', (id) => api.getSessionSummary(b, id)],
      ['resumeSession', (id) => api.resumeSession(b, id)],
      ['startNewSession', (id) => api.startNewSession(b, id)],
      ['stopSession', (id) => api.stopSession(b, id)],
      ['archiveSession', (id) => api.archiveSession(b, id)],
      ['renameSession', (id) => api.renameSession(b, id, 'Volée')],
      ['sendFirstInstruction', (id) => api.sendFirstInstruction(b, id, 'rm -rf')],
    ];
    for (const [name, call] of sessionCalls) {
      const foreign = await call(session.id).catch((error: unknown) => error);
      const unknown = await call(unknownId).catch((error: unknown) => error);
      expect(foreign, name).toMatchObject({ code: 'NOT_FOUND', message: 'Session introuvable.' });
      expect(JSON.stringify(foreign), name).toBe(JSON.stringify(unknown));
    }
    expect(servers.asked).toEqual([]);
    for (const fn of Object.values(runnerMock)) expect(fn).not.toHaveBeenCalled();
    expect(await (await db()).select().from(sessions)).toEqual(before);
    expect(await (await db()).select().from(auditLog)).toHaveLength(0);

    // Lists of B never show A's rows.
    expect((await api.listSessions(b, { status: 'history', period: 'tout' })).items).toEqual([]);
    expect((await api.listSessions(b, { status: 'history', projectId: project.id })).items).toEqual([]);
    expect(await api.listSessionProjects(b)).toEqual([]);
    expect((await api.getNewSessionOptions(b)).projects).toEqual([]);
    expect((await api.listSessions(ctx, { status: 'history', period: 'tout' })).items.map((i) => i.id)).toEqual([session.id]);
  });
});
