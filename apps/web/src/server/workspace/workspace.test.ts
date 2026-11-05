import { auditLog, permissionRequests, projects, pullRequests, sessions, worktrees } from '@nuera/db/schema';
import type { PermissionRequestDto, SessionDto } from '@nuera/shared/runner';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerClient } from '@/server/runner/client';
import { closeWorkspaceTestDb, prepareWorkspaceTestDatabase, resetWorkspaceTables, TEST_USER_ID } from './test/db';

// --- fake runner / GitHub / sessions lot (the real error classes are kept) -----------------------
const runnerMock = {
  getSession: vi.fn<RunnerClient['getSession']>(),
  sendInstruction: vi.fn<RunnerClient['sendInstruction']>(),
  interruptSession: vi.fn<RunnerClient['interruptSession']>(),
  sessionEvents: vi.fn<RunnerClient['sessionEvents']>(),
  sessionTerminal: vi.fn<RunnerClient['sessionTerminal']>(),
  permissionDecision: vi.fn<RunnerClient['permissionDecision']>(),
  worktreeChanges: vi.fn<RunnerClient['worktreeChanges']>(),
  aheadBehind: vi.fn<RunnerClient['aheadBehind']>(),
  readClaudeMd: vi.fn<RunnerClient['readClaudeMd']>(),
  commit: vi.fn<RunnerClient['commit']>(),
  push: vi.fn<RunnerClient['push']>(),
  fileTree: vi.fn<RunnerClient['fileTree']>(),
};
vi.mock('@/server/runner/client', async () => {
  const errors = await import('@/server/runner/errors');
  return { ...errors, runner: runnerMock };
});
const githubMock = {
  getGitAuthForRepo: vi.fn<(fullName: string, access: string) => Promise<{ extraHeader: string; expiresAt: string }>>(async () => ({ extraHeader: 'AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dGVzdA==', expiresAt: new Date().toISOString() })),
  createPullRequest: vi.fn<(input: unknown) => Promise<unknown>>(),
};
vi.mock('@/server/github', () => githubMock);
const resumeMock = vi.fn<(sessionId: string, actor: unknown) => Promise<unknown>>(async () => ({}));
vi.mock('@/server/sessions', () => ({ resumeSession: resumeMock }));

const actor = { id: TEST_USER_ID, name: 'Camille Laurent', email: 'owner@example.test' };
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
    .values({ projectId: project!.id, name: 'export-csv', branch: options.branch ?? 'feature/export-csv', baseBranch: 'main', path: '/srv/dev/.worktrees/devis/export-csv' })
    .returning();
  await d.insert(sessions).values({
    id: SESSION_ID,
    projectId: project!.id,
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
  resumeMock.mockClear();
});

describe('getWorkspaceData', () => {
  it('assembles the page from the database and the runner', async () => {
    const { worktree } = await fixture();
    runnerMock.getSession.mockResolvedValue(dto({ status: 'running', cliStatus: null }));
    runnerMock.sessionEvents.mockResolvedValue({ sessionId: SESSION_ID, items: [], version: 7, hasMore: false });
    runnerMock.worktreeChanges.mockResolvedValue({ branch: 'feature/export-csv', base: null, files: [], totals: { files: 0, insertions: 0, deletions: 0 } });
    runnerMock.aheadBehind.mockResolvedValue({ branch: 'feature/export-csv', base: 'main', ahead: 1, behind: 0, upstream: null, dirtyFiles: 0 });
    const data = await (await ws()).getWorkspaceData(SESSION_ID, actor);
    expect(data).not.toBeNull();
    expect(data!.session.status).toBe('running');
    expect(data!.project.repoName).toBe('devis-express');
    expect(data!.project.commands.test).toBe('npm run test');
    expect(data!.worktree).toMatchObject({ id: worktree.id, present: true });
    expect(data!.events).toEqual({ items: [], version: 7, complete: true });
    expect(data!.branch).toMatchObject({ ahead: 1, base: 'main' });
    expect(data!.siblings).toEqual([expect.objectContaining({ id: SESSION_ID, current: true })]);
    expect(data!.runner).toBe('available');
    expect(runnerMock.aheadBehind).toHaveBeenCalledWith({ params: { worktreeId: worktree.id }, query: { base: 'main' } }, expect.anything());
  });

  it('keeps rendering when the runner is down (no crash, parts are null)', async () => {
    await fixture();
    const { RunnerError } = await import('@/server/runner/errors');
    const down = new RunnerError('RUNNER_UNAVAILABLE', 'VPS-3 ne répond pas');
    for (const fn of [runnerMock.getSession, runnerMock.sessionEvents, runnerMock.worktreeChanges, runnerMock.aheadBehind]) fn.mockRejectedValue(down);
    const data = await (await ws()).getWorkspaceData(SESSION_ID, actor);
    expect(data).toMatchObject({ runner: 'unavailable', events: null, changes: null, branch: null });
    expect(data!.session).toMatchObject({ status: 'waiting_input', live: null });
  });

  it('answers null (404) for an archived or unknown session', async () => {
    await fixture({ archived: true });
    expect(await (await ws()).getWorkspaceData(SESSION_ID, actor)).toBeNull();
    expect(await (await ws()).getWorkspaceData('33333333-3333-4333-8333-333333333333', actor)).toBeNull();
  });
});

describe('sendInstruction', () => {
  it('types into a live CLI without resuming', async () => {
    await fixture();
    runnerMock.getSession.mockResolvedValue(dto());
    runnerMock.sendInstruction.mockResolvedValue({ delivered: true, queued: false, started: false, resumed: false, session: dto({ status: 'running' }) });
    const result = await (await ws()).sendInstruction(SESSION_ID, 'Ajoute un test', actor);
    expect(result).toMatchObject({ delivered: true, status: 'running', resumed: false });
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('resumes a finished session through the sessions lot first', async () => {
    await fixture();
    runnerMock.getSession.mockResolvedValue(dto({ status: 'finished', live: false }));
    runnerMock.sendInstruction.mockResolvedValue({ delivered: false, queued: true, started: false, resumed: false, session: dto({ status: 'running', queuedInstructions: 1 }) });
    const result = await (await ws()).sendInstruction(SESSION_ID, 'Continue', actor);
    expect(resumeMock).toHaveBeenCalledWith(SESSION_ID, actor);
    expect(result).toMatchObject({ queued: true, resumed: true, queuedInstructions: 1 });
  });

  it('keeps the Figma reason when the CLI waits for a permission', async () => {
    await fixture();
    const { RunnerError } = await import('@/server/runner/errors');
    runnerMock.getSession.mockResolvedValue(dto({ status: 'waiting_permission' }));
    runnerMock.sendInstruction.mockRejectedValue(new RunnerError('CONFLICT', "Répondez d'abord à la demande d'autorisation.", { reason: 'SESSION_BUSY_PERMISSION' }));
    const { withWorkspaceErrors } = await ws();
    const response = (await withWorkspaceErrors(async () => (await ws()).sendInstruction(SESSION_ID, 'x', actor))) as Response;
    expect(response.status).toBe(409);
    expect((await response.json()).error).toEqual({
      code: 'CONFLICT',
      message: "Répondez d'abord à la demande d'autorisation ci-dessus.",
      detail: "Répondez d'abord à la demande d'autorisation.",
      untouched: "L'instruction n'a pas été envoyée.",
      reason: 'SESSION_BUSY_PERMISSION',
    });
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

  it('hands « Toujours pour … » to the CLI and journals it as D08 shows it', async () => {
    await withPermission([{ type: 'addRules' }]);
    runnerMock.permissionDecision.mockResolvedValue(decided('allowed_always', 'Toujours pour npm run test'));
    await (await ws()).decidePermission(PERMISSION_ID, { optionId: 'allow_always' }, actor);
    expect(runnerMock.permissionDecision).toHaveBeenCalledWith({
      params: { permissionId: PERMISSION_ID },
      body: { behavior: 'allow', always: true, decidedByUserId: TEST_USER_ID },
    });
    const [entry] = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'permission.decision'));
    expect(entry?.summary).toBe('« toujours autoriser » npm run test · Devis Express');
  });

  it('refuses « Toujours » when the CLI proposed no rule, and passes the deny message', async () => {
    await withPermission(null);
    await expect((await ws()).decidePermission(PERMISSION_ID, { optionId: 'allow_always' }, actor)).rejects.toMatchObject({ code: 'VALIDATION' });
    runnerMock.permissionDecision.mockResolvedValue(decided('denied'));
    await (await ws()).decidePermission(PERMISSION_ID, { optionId: 'deny', message: 'Pas maintenant' }, actor);
    expect(runnerMock.permissionDecision).toHaveBeenLastCalledWith({
      params: { permissionId: PERMISSION_ID },
      body: { behavior: 'deny', always: false, message: 'Pas maintenant', decidedByUserId: TEST_USER_ID },
    });
  });
});

describe('Git (W5)', () => {
  it('commits with the owner as author and audits', async () => {
    const { worktree } = await fixture();
    runnerMock.commit.mockResolvedValue({ operationId: null, sha: 'a3f9c12aaaaaaaa', shortSha: 'a3f9c12', branch: 'feature/export-csv', filesCommitted: 2, insertions: 10, deletions: 1 });
    const result = await (await ws()).commitChanges(worktree.id, { message: 'csv : export', paths: ['a.js', 'b.js'], sessionId: SESSION_ID }, actor);
    expect(result.shortSha).toBe('a3f9c12');
    expect(runnerMock.commit).toHaveBeenCalledWith({
      params: { worktreeId: worktree.id },
      body: expect.objectContaining({ message: 'csv : export', author: { name: 'Camille Laurent', email: 'owner@example.test' }, paths: ['a.js', 'b.js'] }),
    });
    const [entry] = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'git.commit'));
    expect(entry?.summary).toBe('commit a3f9c12 « csv : export » · feature/export-csv · Devis Express');
  });

  it('pushes with a write token and refuses the default branch', async () => {
    const { worktree } = await fixture();
    runnerMock.push.mockResolvedValue({ operationId: null, branch: 'feature/export-csv', remoteBranch: 'feature/export-csv', headSha: 'abc', upToDate: false, createdRemoteBranch: true });
    const result = await (await ws()).pushBranch(worktree.id, {}, actor);
    expect(githubMock.getGitAuthForRepo).toHaveBeenCalledWith('atelier-test/devis-express', 'write');
    expect(runnerMock.push.mock.calls[0]![0].body).toMatchObject({ protectedBranches: ['main'], setUpstream: true });
    expect(result.url).toBe('https://github.com/atelier-test/devis-express/tree/feature/export-csv');

    await resetWorkspaceTables();
    const main = await fixture({ branch: 'main' });
    await expect((await ws()).pushBranch(main.worktree.id, {}, actor)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('opens the pull request, stores it and audits', async () => {
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
    const pr = await (await ws()).openPullRequest(worktree.id, { title: 'Export CSV', body: 'Détails', sessionId: SESSION_ID }, actor);
    expect(githubMock.createPullRequest).toHaveBeenCalledWith({ fullName: 'atelier-test/devis-express', title: 'Export CSV', head: 'feature/export-csv', base: 'main', body: 'Détails' });
    expect(pr).toMatchObject({ number: 12, baseBranch: 'main' });
    const [row] = await (await db()).select().from(pullRequests).where(eq(pullRequests.projectId, project.id));
    expect(row).toMatchObject({ number: 12, sessionId: SESSION_ID, headBranch: 'feature/export-csv' });
    const [entry] = await (await db()).select().from(auditLog).where(eq(auditLog.action, 'github.pull_request'));
    expect(entry?.summary).toBe('pull request #12 ouverte : « Export CSV » · feature/export-csv → main · Devis Express');
  });

  it('refuses a removed worktree', async () => {
    const { worktree } = await fixture();
    await (await db()).update(worktrees).set({ removedAt: new Date(), status: 'removed' }).where(eq(worktrees.id, worktree.id));
    await expect((await ws()).getTree(worktree.id, '')).rejects.toMatchObject({ code: 'CONFLICT' });
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
});
