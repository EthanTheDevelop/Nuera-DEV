import { auditLog, permissionRequests, projects, pullRequests, sessions, userPreferences, worktrees } from '@nuera/db/schema';
import type { PermissionRequestDto, SessionDto } from '@nuera/shared/runner';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerClient } from '@/server/runner/client';
import { closeWorkspaceTestDb, prepareWorkspaceTestDatabase, resetWorkspaceTables, testContext, TEST_ENVIRONMENT_ID, TEST_SPACE_ID, TEST_USER_ID } from './test/db';

// --- fake runner / GitHub / sessions lot (the real error classes are kept) -----------------------
const runnerMock = {
  getSession: vi.fn<RunnerClient['getSession']>(),
  sendInstruction: vi.fn<RunnerClient['sendInstruction']>(),
  interruptSession: vi.fn<RunnerClient['interruptSession']>(),
  sessionEvents: vi.fn<RunnerClient['sessionEvents']>(),
  sessionTerminal: vi.fn<RunnerClient['sessionTerminal']>(),
  permissionDecision: vi.fn<RunnerClient['permissionDecision']>(),
  worktreeChanges: vi.fn<RunnerClient['worktreeChanges']>(),
  worktreeDiff: vi.fn<RunnerClient['worktreeDiff']>(),
  worktreeStatus: vi.fn<RunnerClient['worktreeStatus']>(),
  stagePaths: vi.fn<RunnerClient['stagePaths']>(),
  unstagePaths: vi.fn<RunnerClient['unstagePaths']>(),
  aheadBehind: vi.fn<RunnerClient['aheadBehind']>(),
  readClaudeMd: vi.fn<RunnerClient['readClaudeMd']>(),
  commit: vi.fn<RunnerClient['commit']>(),
  push: vi.fn<RunnerClient['push']>(),
  fileTree: vi.fn<RunnerClient['fileTree']>(),
  readFile: vi.fn<RunnerClient['readFile']>(),
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
type ProjectRef = { id: string; spaceId: string; githubSourceId: string | null; githubFullName: string };
const githubMock = vi.hoisted(() => ({
  getGitAuthForProject: vi.fn<(project: ProjectRef, access: string) => Promise<{ extraHeader: string; expiresAt: string; sourceId: string | null }>>(),
  createPullRequest: vi.fn<(project: ProjectRef, input: unknown) => Promise<unknown>>(),
  listProtectedBranches: vi.fn<(project: ProjectRef, defaultBranch: string, options?: unknown) => Promise<string[]>>(),
}));
vi.mock('@/server/github', () => githubMock);
const resumeMock = vi.hoisted(() => vi.fn<(ctx: unknown, sessionId: string, options?: { context?: boolean }) => Promise<unknown>>());
const startMock = vi.hoisted(() => vi.fn<(ctx: unknown, sessionId: string) => Promise<unknown>>());
vi.mock('@/server/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/sessions')>()),
  resumeSession: resumeMock,
  startNewSession: startMock,
}));

const ctx = testContext();
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const PERMISSION_ID = '22222222-2222-4222-8222-222222222222';

async function db() {
  return (await import('@/server/db')).db;
}
async function ws() {
  return import('./index');
}

function dto(overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    id: SESSION_ID,
    projectId: '00000000-0000-4000-8000-000000000000',
    worktreeId: null,
    title: 'Export CSV',
    status: 'waiting_input',
    backend: 'pty',
    tmuxName: null,
    permissionMode: 'manual',
    model: null,
    effort: null,
    remoteControl: false,
    remoteControlUrl: null,
    live: true,
    resumable: true,
    pid: 1,
    terminalId: 't-1',
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
    startedAt: new Date().toISOString(),
    endedAt: null,
    lastActivityAt: null,
    createdAt: new Date().toISOString(),
    worktree: null,
    ...overrides,
  };
}

async function fixture(options: { archived?: boolean; branch?: string } = {}) {
  const d = await db();
  const [project] = await d
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
      commands: { test: 'npm run test' },
    })
    .returning();
  const [worktree] = await d
    .insert(worktrees)
    .values({
      projectId: project!.id,
      environmentId: TEST_ENVIRONMENT_ID,
      name: 'export-csv',
      branch: options.branch ?? 'feature/export-csv',
      baseBranch: 'main',
      path: '/srv/dev/.worktrees/devis/export-csv',
    })
    .returning();
  await d.insert(sessions).values({
    id: SESSION_ID,
    projectId: project!.id,
    environmentId: TEST_ENVIRONMENT_ID,
    worktreeId: worktree!.id,
    title: 'Export CSV',
    status: options.archived ? 'archived' : 'waiting_input',
    backend: 'pty',
    ...(options.archived ? { archivedAt: new Date() } : {}),
  });
  return { project: project!, worktree: worktree! };
}

beforeAll(async () => {
  await prepareWorkspaceTestDatabase('service');
});
afterAll(async () => {
  await closeWorkspaceTestDb();
});
beforeEach(async () => {
  await resetWorkspaceTables();
  for (const fn of Object.values(runnerMock)) fn.mockReset();
  githubMock.createPullRequest.mockReset();
  githubMock.getGitAuthForProject.mockReset();
  githubMock.getGitAuthForProject.mockResolvedValue({ extraHeader: 'AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dGVzdA==', expiresAt: new Date().toISOString(), sourceId: null });
  githubMock.listProtectedBranches.mockReset();
  githubMock.listProtectedBranches.mockImplementation(async (_project, defaultBranch) => [defaultBranch]);
  resumeMock.mockReset();
  resumeMock.mockResolvedValue({});
  startMock.mockReset();
  startMock.mockResolvedValue({});
  servers.asked.length = 0;
});

describe('getWorkspaceData', () => {
  it('assembles the page from the database and the runner of the session server', async () => {
    const { worktree } = await fixture();
    runnerMock.getSession.mockResolvedValue(dto({ status: 'running', cliStatus: null }));
    runnerMock.sessionEvents.mockResolvedValue({ sessionId: SESSION_ID, items: [], version: 7, hasMore: false });
    runnerMock.worktreeChanges.mockResolvedValue({ branch: 'feature/export-csv', base: null, files: [], totals: { files: 0, insertions: 0, deletions: 0 } });
    runnerMock.aheadBehind.mockResolvedValue({ branch: 'feature/export-csv', base: 'main', ahead: 1, behind: 0, upstream: null, dirtyFiles: 0 });
    const data = await (await ws()).getWorkspaceData(ctx, SESSION_ID);
    expect(data).not.toBeNull();
    expect(data!.session.status).toBe('running');
    expect(data!.project.repoName).toBe('devis-express');
    expect(data!.project.commands.test).toBe('npm run test');
    expect(data!.worktree).toMatchObject({ id: worktree.id, present: true });
    expect(data!.events).toEqual({ items: [], version: 7, complete: true });
    expect(data!.branch).toMatchObject({ ahead: 1, base: 'main' });
    expect(data!.siblings).toEqual([expect.objectContaining({ id: SESSION_ID, current: true })]);
    expect(data!.runner).toBe('available');
    expect(data!.environment).toEqual({ id: TEST_ENVIRONMENT_ID, name: 'VPS-3' });
    expect(data!.author).toEqual({ name: 'Camille Laurent', email: 'owner@example.test' });
    expect(data!.capacity).toEqual({ live: 1, max: 4 });
    expect(runnerMock.aheadBehind).toHaveBeenCalledWith({ params: { worktreeId: worktree.id }, query: { base: 'main' } }, expect.anything());
    expect(new Set(servers.asked)).toEqual(new Set([TEST_ENVIRONMENT_ID]));
  });

  it('keeps rendering when the runner is down (no crash, parts are null)', async () => {
    await fixture();
    const { RunnerError } = await import('@/server/runner/errors');
    const down = new RunnerError('RUNNER_UNAVAILABLE', 'VPS-3 ne répond pas');
    for (const fn of [runnerMock.getSession, runnerMock.sessionEvents, runnerMock.worktreeChanges, runnerMock.aheadBehind]) fn.mockRejectedValue(down);
    const data = await (await ws()).getWorkspaceData(ctx, SESSION_ID);
    expect(data).toMatchObject({ runner: 'unavailable', events: null, changes: null, branch: null });
    expect(data!.session).toMatchObject({ status: 'waiting_input', live: null });
  });

  it('answers null (404) for an archived or unknown session', async () => {
    await fixture({ archived: true });
    expect(await (await ws()).getWorkspaceData(ctx, SESSION_ID)).toBeNull();
    expect(await (await ws()).getWorkspaceData(ctx, '33333333-3333-4333-8333-333333333333')).toBeNull();
  });
});

describe('sendInstruction', () => {
  it('types into a live CLI without resuming', async () => {
    await fixture();
    runnerMock.getSession.mockResolvedValue(dto());
    runnerMock.sendInstruction.mockResolvedValue({ delivered: true, queued: false, started: false, resumed: false, session: dto({ status: 'running' }) });
    const result = await (await ws()).sendInstruction(ctx, SESSION_ID, 'Ajoute un test');
    expect(result).toMatchObject({ delivered: true, status: 'running', resumed: false });
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('resumes a finished session through the sessions lot first, for the account that writes', async () => {
    await fixture();
    runnerMock.getSession.mockResolvedValue(dto({ status: 'finished', live: false }));
    runnerMock.sendInstruction.mockResolvedValue({ delivered: false, queued: true, started: false, resumed: false, session: dto({ status: 'running', queuedInstructions: 1 }) });
    const result = await (await ws()).sendInstruction(ctx, SESSION_ID, 'Continue');
    expect(resumeMock).toHaveBeenCalledWith(ctx, SESSION_ID, { context: false });
    expect(startMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ queued: true, resumed: true, started: false, queuedInstructions: 1 });
  });

  it('starts a new session through the sessions lot first (launch options of the space), then queues the instruction', async () => {
    await fixture();
    runnerMock.getSession.mockResolvedValue(dto({ status: 'new', live: false }));
    runnerMock.sendInstruction.mockResolvedValue({ delivered: false, queued: true, started: false, resumed: false, session: dto({ status: 'running', queuedInstructions: 1 }) });
    const result = await (await ws()).sendInstruction(ctx, SESSION_ID, 'Lis CLAUDE.md');
    expect(startMock).toHaveBeenCalledWith(ctx, SESSION_ID);
    expect(resumeMock).not.toHaveBeenCalled();
    expect(startMock.mock.invocationCallOrder[0]!).toBeLessThan(runnerMock.sendInstruction.mock.invocationCallOrder[0]!);
    expect(result).toMatchObject({ queued: true, started: true, resumed: false });
  });

  it('does not start a launch again while the CLI runs or a start refuses', async () => {
    await fixture();
    runnerMock.getSession.mockResolvedValue(dto({ status: 'running', live: true }));
    runnerMock.sendInstruction.mockResolvedValue({ delivered: true, queued: false, started: false, resumed: false, session: dto({ status: 'running' }) });
    await (await ws()).sendInstruction(ctx, SESSION_ID, 'Continue');
    expect(startMock).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();

    const { RunnerError } = await import('@/server/runner/errors');
    runnerMock.getSession.mockResolvedValue(dto({ status: 'new', live: false }));
    startMock.mockRejectedValue(new RunnerError('FORBIDDEN', 'Le mode sans autorisation est bloqué dans les paramètres.', { reason: 'BYPASS_BLOCKED' }));
    runnerMock.sendInstruction.mockClear();
    await expect((await ws()).sendInstruction(ctx, SESSION_ID, 'x')).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'BYPASS_BLOCKED' });
    expect(runnerMock.sendInstruction).not.toHaveBeenCalled();
  });

  it('keeps the Figma reason when the CLI waits for a permission', async () => {
    await fixture();
    const { RunnerError } = await import('@/server/runner/errors');
    runnerMock.getSession.mockResolvedValue(dto({ status: 'waiting_permission' }));
    runnerMock.sendInstruction.mockRejectedValue(new RunnerError('CONFLICT', "Répondez d'abord à la demande d'autorisation.", { reason: 'SESSION_BUSY_PERMISSION' }));
    const { withWorkspaceErrors } = await ws();
    const response = (await withWorkspaceErrors(async () => (await ws()).sendInstruction(ctx, SESSION_ID, 'x'))) as Response;
    expect(response.status).toBe(409);
    expect((await response.json()).error).toEqual({
      code: 'CONFLICT',
      message: "Répondez d'abord à la demande d'autorisation ci-dessus.",
      detail: "Répondez d'abord à la demande d'autorisation.",
      untouched: "L'instruction n'a pas été envoyée.",
      reason: 'SESSION_BUSY_PERMISSION',
    });
  });

  it('keeps the reason of a web refusal (no server assigned)', async () => {
    const { AppError } = await import('@/server/errors');
    const { workspaceErrorBody } = await ws();
    const { body, status } = workspaceErrorBody(new AppError('CONFLICT', 'Aucun serveur ne vous est encore attribué : un administrateur doit vous en attribuer un.', { reason: 'NO_ENVIRONMENT' }));
    expect(status).toBe(409);
    expect(body.error).toMatchObject({ code: 'CONFLICT', reason: 'NO_ENVIRONMENT' });
  });
});

describe('decidePermission', () => {
  async function withPermission(suggestions: unknown[] | null) {
    await fixture();
    await (await db()).insert(permissionRequests).values({
      id: PERMISSION_ID,
      sessionId: SESSION_ID,
      toolName: 'Bash',
      toolInput: { command: 'npm run test' },
      title: 'Claude demande à exécuter une commande',
      target: 'npm run test',
      suggestions,
    });
  }
  const decided = (status: PermissionRequestDto['status'], alwaysLabel: string | null = null): PermissionRequestDto => ({
    id: PERMISSION_ID,
    sessionId: SESSION_ID,
    toolName: 'Bash',
    title: 'Claude demande à exécuter une commande',
    target: 'npm run test',
    detail: null,
    status,
    options: [],
    alwaysLabel,
    suggestions: null,
    decisionMessage: null,
    createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
    expiresAt: null,
  });

  it('hands « Toujours pour … » to the CLI and journals it in the space, with the account that decided', async () => {
    await withPermission([{ type: 'addRules' }]);
    runnerMock.permissionDecision.mockResolvedValue(decided('allowed_always', 'Toujours pour npm run test'));
    await (await ws()).decidePermission(ctx, PERMISSION_ID, { optionId: 'allow_always' });
    expect(runnerMock.permissionDecision).toHaveBeenCalledWith({
      params: { permissionId: PERMISSION_ID },
      body: { behavior: 'allow', always: true, decidedByUserId: TEST_USER_ID },
    });
    const [entry] = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'permission.decision'));
    expect(entry?.summary).toBe('« toujours autoriser » npm run test · Devis Express');
    expect(entry).toMatchObject({ actorUserId: TEST_USER_ID, actorLabel: 'owner@example.test', spaceId: TEST_SPACE_ID, environmentId: TEST_ENVIRONMENT_ID });
  });

  it('refuses « Toujours » when the CLI proposed no rule, and passes the deny message', async () => {
    await withPermission(null);
    await expect((await ws()).decidePermission(ctx, PERMISSION_ID, { optionId: 'allow_always' })).rejects.toMatchObject({ code: 'VALIDATION' });
    runnerMock.permissionDecision.mockResolvedValue(decided('denied'));
    await (await ws()).decidePermission(ctx, PERMISSION_ID, { optionId: 'deny', message: 'Pas maintenant' });
    expect(runnerMock.permissionDecision).toHaveBeenLastCalledWith({
      params: { permissionId: PERMISSION_ID },
      body: { behavior: 'deny', always: false, message: 'Pas maintenant', decidedByUserId: TEST_USER_ID },
    });
  });
});

describe('Git (W5)', () => {
  it('commits with the account as author and audits in the space', async () => {
    const { worktree } = await fixture();
    runnerMock.commit.mockResolvedValue({ operationId: null, sha: 'a3f9c12aaaaaaaa', shortSha: 'a3f9c12', branch: 'feature/export-csv', filesCommitted: 2, insertions: 10, deletions: 1 });
    const result = await (await ws()).commitChanges(ctx, worktree.id, { message: 'csv : export', paths: ['a.js', 'b.js'], sessionId: SESSION_ID });
    expect(result.shortSha).toBe('a3f9c12');
    expect(runnerMock.commit).toHaveBeenCalledWith({
      params: { worktreeId: worktree.id },
      body: expect.objectContaining({ message: 'csv : export', author: { name: 'Camille Laurent', email: 'owner@example.test' }, paths: ['a.js', 'b.js'], actorUserId: TEST_USER_ID }),
    });
    const [entry] = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'git.commit'));
    expect(entry?.summary).toBe('commit a3f9c12 « csv : export » · feature/export-csv · Devis Express');
    expect(entry).toMatchObject({ spaceId: TEST_SPACE_ID, environmentId: TEST_ENVIRONMENT_ID });
  });

  it('commits with the Git identity chosen in Paramètres, shown as the author of the page', async () => {
    const { worktree } = await fixture();
    await (await db()).update(userPreferences).set({ gitAuthorName: 'Camille L.', gitAuthorEmail: 'camille@atelier.test' }).where(eq(userPreferences.userId, TEST_USER_ID));
    (await import('@/server/settings')).invalidateSettingsCache();
    runnerMock.commit.mockResolvedValue({ operationId: null, sha: 'b'.repeat(40), shortSha: 'bbbbbbb', branch: 'feature/export-csv', filesCommitted: 1, insertions: 1, deletions: 0 });
    await (await ws()).commitChanges(ctx, worktree.id, { message: 'x', paths: ['a.js'] });
    expect(runnerMock.commit.mock.calls[0]![0].body).toMatchObject({ author: { name: 'Camille L.', email: 'camille@atelier.test' } });
    const data = await (await ws()).getWorkspaceData(ctx, SESSION_ID);
    expect(data?.author).toEqual({ name: 'Camille L.', email: 'camille@atelier.test' });
  });

  it('pushes with a write token of the project source and refuses the default branch', async () => {
    const { worktree, project } = await fixture();
    runnerMock.push.mockResolvedValue({ operationId: null, branch: 'feature/export-csv', remoteBranch: 'feature/export-csv', headSha: 'abc', upToDate: false, createdRemoteBranch: true });
    const result = await (await ws()).pushBranch(ctx, worktree.id, {});
    expect(githubMock.getGitAuthForProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: project.id, spaceId: TEST_SPACE_ID, environmentId: TEST_ENVIRONMENT_ID, githubFullName: 'atelier-test/devis-express' }),
      'write',
    );
    expect(runnerMock.push.mock.calls[0]![0].body).toMatchObject({ protectedBranches: ['main'], setUpstream: true, actorUserId: TEST_USER_ID });
    expect(result.url).toBe('https://github.com/atelier-test/devis-express/tree/feature/export-csv');
    const [entry] = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'git.push'));
    expect(entry).toMatchObject({ actorUserId: TEST_USER_ID, targetType: 'project', spaceId: TEST_SPACE_ID, environmentId: TEST_ENVIRONMENT_ID });
    expect(entry?.summary).toBe('push de feature/export-csv vers origin/feature/export-csv · Devis Express');
    expect(JSON.stringify(entry)).not.toMatch(/AUTHORIZATION|basic /i);

    await resetWorkspaceTables();
    const main = await fixture({ branch: 'main' });
    await expect((await ws()).pushBranch(ctx, main.worktree.id, {})).rejects.toMatchObject({ code: 'CONFLICT' });
    // A branch protected on GitHub is refused before any token is minted, and the list goes to the runner.
    await resetWorkspaceTables();
    const release = await fixture({ branch: 'release' });
    githubMock.getGitAuthForProject.mockClear();
    githubMock.listProtectedBranches.mockResolvedValueOnce(['main', 'release']);
    await expect((await ws()).pushBranch(ctx, release.worktree.id, {})).rejects.toMatchObject({ code: 'CONFLICT', untouched: "Rien n'a été envoyé sur GitHub." });
    expect(githubMock.getGitAuthForProject).not.toHaveBeenCalled();
    expect(githubMock.listProtectedBranches).toHaveBeenLastCalledWith(expect.objectContaining({ id: release.project.id, githubFullName: 'atelier-test/devis-express' }), 'main', { maxAgeMs: 0 });
  });

  it('opens the pull request through the project source, stores it and audits', async () => {
    const { worktree, project } = await fixture();
    githubMock.createPullRequest.mockResolvedValue({
      number: 12,
      title: 'Export CSV',
      url: 'https://github.com/atelier-test/devis-express/pull/12',
      state: 'open',
      draft: false,
      headRef: 'feature/export-csv',
      headSha: 'abcdef1234',
      baseRef: 'main',
      createdAt: null,
    });
    const pr = await (await ws()).openPullRequest(ctx, worktree.id, { title: 'Export CSV', body: 'Détails', sessionId: SESSION_ID });
    expect(githubMock.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ id: project.id, spaceId: TEST_SPACE_ID }), {
      title: 'Export CSV',
      head: 'feature/export-csv',
      base: 'main',
      body: 'Détails',
    });
    expect(pr).toMatchObject({ number: 12, baseBranch: 'main' });
    const [row] = await (await db()).select().from(pullRequests).where(eq(pullRequests.projectId, project.id));
    expect(row).toMatchObject({ number: 12, sessionId: SESSION_ID, headBranch: 'feature/export-csv' });
    const [entry] = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'github.pull_request'));
    expect(entry?.summary).toBe('pull request #12 ouverte : « Export CSV » · feature/export-csv → main · Devis Express');
  });

  it('refuses a session id that does not work in this worktree', async () => {
    const { worktree, project } = await fixture();
    const [other] = await (await db())
      .insert(worktrees)
      .values({ projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, name: 'autre', branch: 'feature/autre', baseBranch: 'main', path: '/srv/dev/.worktrees/devis/autre' })
      .returning();
    await expect((await ws()).commitChanges(ctx, other!.id, { message: 'x', paths: ['a.js'], sessionId: SESSION_ID })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect((await ws()).pushBranch(ctx, other!.id, { sessionId: SESSION_ID })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(runnerMock.commit).not.toHaveBeenCalled();
    expect(runnerMock.push).not.toHaveBeenCalled();
    expect(worktree.id).not.toBe(other!.id);
  });

  it('refuses a removed worktree', async () => {
    const { worktree } = await fixture();
    await (await db()).update(worktrees).set({ removedAt: new Date(), status: 'removed' }).where(eq(worktrees.id, worktree.id));
    await expect((await ws()).getTree(ctx, worktree.id, '')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('isolation between spaces', () => {
  it('answers an id of another space exactly like an unknown id: no runner call, no GitHub call, no write, no journal', async () => {
    const { worktree } = await fixture();
    await (await db()).insert(permissionRequests).values({
      id: PERMISSION_ID,
      sessionId: SESSION_ID,
      toolName: 'Bash',
      toolInput: { command: 'npm run test' },
      title: 'Claude demande à exécuter une commande',
      target: 'npm run test',
      suggestions: [{ type: 'addRules' }],
    });
    const { createTestAccount } = await import('@/server/tenancy/test/fixtures');
    const b = (await createTestAccount({ role: 'member', name: 'Lou Martin', email: 'lou@example.test' })).ctx;
    const api = await ws();
    const unknown = crypto.randomUUID();
    servers.asked.length = 0;
    const before = {
      sessions: await (await db()).select().from(sessions),
      permissions: await (await db()).select().from(permissionRequests),
      pullRequests: await (await db()).select().from(pullRequests),
    };

    const cases: Array<{ name: string; foreign: string; call: (id: string) => Promise<unknown>; message: string }> = [
      { name: 'getSessionEventsPage', foreign: SESSION_ID, call: (id) => api.getSessionEventsPage(b, id, 0), message: 'Session introuvable.' },
      { name: 'sendInstruction', foreign: SESSION_ID, call: (id) => api.sendInstruction(b, id, 'rm -rf'), message: 'Session introuvable.' },
      { name: 'interruptSession', foreign: SESSION_ID, call: (id) => api.interruptSession(b, id), message: 'Session introuvable.' },
      { name: 'getSessionTerminal', foreign: SESSION_ID, call: (id) => api.getSessionTerminal(b, id), message: 'Session introuvable.' },
      { name: 'decidePermission', foreign: PERMISSION_ID, call: (id) => api.decidePermission(b, id, { optionId: 'allow_always' }), message: "Demande d'autorisation introuvable." },
      { name: 'getChanges', foreign: worktree.id, call: (id) => api.getChanges(b, id), message: 'Worktree introuvable.' },
      { name: 'getDiff', foreign: worktree.id, call: (id) => api.getDiff(b, id, 'a.js'), message: 'Worktree introuvable.' },
      { name: 'getWorktreeStatus', foreign: worktree.id, call: (id) => api.getWorktreeStatus(b, id), message: 'Worktree introuvable.' },
      { name: 'stagePaths', foreign: worktree.id, call: (id) => api.stagePaths(b, id, ['a.js']), message: 'Worktree introuvable.' },
      { name: 'unstagePaths', foreign: worktree.id, call: (id) => api.unstagePaths(b, id, ['a.js']), message: 'Worktree introuvable.' },
      { name: 'getTree', foreign: worktree.id, call: (id) => api.getTree(b, id, ''), message: 'Worktree introuvable.' },
      { name: 'getFile', foreign: worktree.id, call: (id) => api.getFile(b, id, 'a.js'), message: 'Worktree introuvable.' },
      { name: 'commitChanges', foreign: worktree.id, call: (id) => api.commitChanges(b, id, { message: 'x', paths: ['a.js'] }), message: 'Worktree introuvable.' },
      { name: 'pushBranch', foreign: worktree.id, call: (id) => api.pushBranch(b, id, {}), message: 'Worktree introuvable.' },
      { name: 'openPullRequest', foreign: worktree.id, call: (id) => api.openPullRequest(b, id, { title: 'Volée' }), message: 'Worktree introuvable.' },
    ];
    for (const { name, foreign, call, message } of cases) {
      const fromForeign = await call(foreign).catch((error: unknown) => error);
      const fromUnknown = await call(unknown).catch((error: unknown) => error);
      expect(fromForeign, name).toMatchObject({ code: 'NOT_FOUND', message });
      expect(JSON.stringify(fromForeign), name).toBe(JSON.stringify(fromUnknown));
      const { status, body } = api.workspaceErrorBody(fromForeign);
      expect({ status, body }, name).toEqual(api.workspaceErrorBody(fromUnknown));
    }
    expect(await api.getWorkspaceData(b, SESSION_ID)).toBeNull();

    expect(servers.asked).toEqual([]);
    for (const fn of Object.values(runnerMock)) expect(fn).not.toHaveBeenCalled();
    for (const fn of Object.values(githubMock)) expect(fn).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
    expect({
      sessions: await (await db()).select().from(sessions),
      permissions: await (await db()).select().from(permissionRequests),
      pullRequests: await (await db()).select().from(pullRequests),
    }).toEqual(before);
    expect(await (await db()).select().from(auditLog)).toHaveLength(0);
  });
});

describe('pure helpers', () => {
  it('maps the options and the journal line', async () => {
    const { decisionFromOption, permissionAuditSummary, alwaysPrefix } = await ws();
    expect(decisionFromOption('allow')).toEqual({ behavior: 'allow', always: false });
    expect(decisionFromOption('deny')).toEqual({ behavior: 'deny', always: false });
    expect(alwaysPrefix('Toujours pour npm run test')).toBe('npm run test');
    expect(permissionAuditSummary({ optionId: 'allow', target: 'rm x', toolName: 'Bash', projectName: 'P' })).toBe('« autoriser une fois » rm x · P');
  });

  it('withholds the content of secret files from the preview', async () => {
    const { isSecretFile, getFile } = await ws();
    expect(['.env', 'app/.env.local', '.env.production', 'deploy/id_ed25519', 'certs/server.key'].map(isSecretFile)).toEqual([true, true, true, true, true]);
    expect(['.env.example', '.env.sample', 'src/env.ts', 'README.md'].map(isSecretFile)).toEqual([false, false, false, false]);
    const { worktree } = await fixture();
    runnerMock.readFile.mockResolvedValue({ path: '.env', size: 20, binary: false, truncated: false, content: 'TOKEN=abc', language: 'dotenv', lines: 1, modifiedAt: null });
    const file = await getFile(ctx, worktree.id, '.env');
    expect(file).toMatchObject({ content: null, secret: true, lines: 1 });
  });
});
