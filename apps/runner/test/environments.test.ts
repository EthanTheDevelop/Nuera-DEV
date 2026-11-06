import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { commandRuns, environments, operations, permissionRequests, projects, sessions, uptimeDaily, worktrees } from '@nuera/db';
import { HealthResponseSchema, LIVE_SESSION_STATUSES, RUNNER_CONTRACT_VERSION, type SessionDto } from '@nuera/shared/runner';
import { hashToken, tokenFingerprint } from '@nuera/shared/tokens';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRunner } from '../src/app';
import { MARKER_FILE } from '../src/environment';
import {
  authFor,
  cleanup,
  createBareRemote,
  dbReady,
  defaultServer,
  git,
  seedProject,
  seedServer,
  silentLogger,
  startTestRunner,
  testConfig,
  tmpDir,
  waitFor,
  type TestEnv,
  type TestServer,
} from './helpers';

type ErrorBody = { error: { code: string; message: string; reason?: string } };

/**
 * Two runners (two servers) on ONE database (docs/MULTICOMPTE.md §4 and §13): every list, job and
 * id lookup stays within the runner's own server; an id of the other server answers exactly like an
 * unknown id, without any write; standby, lease and folder markers.
 */
describe.skipIf(!dbReady)('two servers on one database', () => {
  const TOKEN_B = `test-runner-token-serveur-b-${Date.now().toString(36)}`;
  let a: TestEnv;
  let b: TestEnv;
  let serverA: TestServer;
  let serverB: TestServer;
  let projectA: typeof projects.$inferSelect;
  let projectB: typeof projects.$inferSelect;
  let claudeA: string;
  let claudeB: string;
  const extra: TestEnv[] = [];

  const call = (env: TestEnv, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    env.runner.api.inject({
      method,
      url,
      headers: { ...env.auth, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  const cloneInto = (env: TestEnv, fullName: string, folder: string) => {
    const remote = createBareRemote(env.dirs.remotes, fullName);
    const target = path.join(env.dirs.projects, folder);
    git(env.dirs.projects, 'clone', remote.bare, target);
    return target;
  };

  beforeAll(async () => {
    claudeA = tmpDir('claude-a');
    claudeB = tmpDir('claude-b');
    // Fake CLI login state per Claude config dir: A is connected, B is not.
    writeFileSync(path.join(claudeA, 'nuera-fake-claude.json'), JSON.stringify({ loggedIn: true, email: 'ethan@example.test' }));
    writeFileSync(path.join(claudeB, 'nuera-fake-claude.json'), JSON.stringify({ loggedIn: false }));
    a = await startTestRunner({ claudeConfigDir: claudeA });
    serverA = await defaultServer(a.db);
    serverB = await seedServer(a.db, { token: TOKEN_B, name: 'Serveur B', maxConcurrentSessions: 3 });
    b = await startTestRunner({ token: TOKEN_B, claudeConfigDir: claudeB });
    projectA = await seedProject(a.db, { fullName: 'nuera-studio/alpha', path: cloneInto(a, 'nuera-studio/alpha', 'alpha'), slug: 'alpha', server: serverA });
    projectB = await seedProject(a.db, { fullName: 'nuera-studio/beta', path: cloneInto(b, 'nuera-studio/beta', 'beta'), slug: 'beta', server: serverB });
  }, 600_000);

  afterAll(async () => {
    for (const env of extra) await env.close().catch(() => undefined);
    await b?.close().catch(() => undefined);
    await a?.close().catch(() => undefined);
    cleanup(claudeA);
    cleanup(claudeB);
  }, 600_000);

  it('serves its own server: health, session list and capacity', async () => {
    const healthA = HealthResponseSchema.parse((await call(a, 'GET', '/v1/health')).json());
    const healthB = HealthResponseSchema.parse((await call(b, 'GET', '/v1/health')).json());
    expect(healthA).toMatchObject({ environment: { id: serverA.environmentId, name: 'VPS-3' }, state: 'ready', contractVersion: RUNNER_CONTRACT_VERSION });
    expect(healthB).toMatchObject({ environment: { id: serverB.environmentId, name: 'Serveur B' }, state: 'ready', contractVersion: RUNNER_CONTRACT_VERSION });
    // The token of A never opens B.
    expect((await b.runner.api.inject({ method: 'GET', url: '/v1/health', headers: a.auth })).statusCode).toBe(401);

    const sessionA = (await call(a, 'POST', '/v1/sessions', { projectId: projectA.id, title: 'Session A', worktree: { mode: 'primary' } })).json() as SessionDto;
    const sessionB = (await call(b, 'POST', '/v1/sessions', { projectId: projectB.id, title: 'Session B', worktree: { mode: 'primary' } })).json() as SessionDto;
    const [rowA] = await a.db.select().from(sessions).where(eq(sessions.id, sessionA.id));
    expect(rowA!.environmentId).toBe(serverA.environmentId);
    const [wtB] = await a.db.select().from(worktrees).where(eq(worktrees.id, sessionB.worktreeId!));
    expect(wtB!.environmentId).toBe(serverB.environmentId);

    const listA = (await call(a, 'GET', '/v1/sessions')).json() as { sessions: SessionDto[]; capacity: { live: number; max: number } };
    const listB = (await call(b, 'GET', '/v1/sessions')).json() as { sessions: SessionDto[]; capacity: { live: number; max: number } };
    expect(listA.sessions.map((s) => s.id)).toContain(sessionA.id);
    expect(listA.sessions.map((s) => s.id)).not.toContain(sessionB.id);
    expect(listB.sessions.map((s) => s.id)).toEqual([sessionB.id]);
    // Capacity of each server comes from its own row.
    expect(listA.capacity.max).toBe(4);
    expect(listB.capacity.max).toBe(3);
    // A launch value (an older web, a launch.json written before the server existed) may only be stricter.
    expect(await b.runner.services.sessions.maxSessions(10)).toBe(3);
    expect(await b.runner.services.sessions.maxSessions(2)).toBe(2);
    expect(await b.runner.services.sessions.maxSessions(null)).toBe(3);
  });

  it('answers an id of the other server exactly like an unknown id, before any write', async () => {
    // Rows of server A: a session (and its worktree), a pending permission, an operation, a run.
    const sessionA = (await call(a, 'POST', '/v1/sessions', { projectId: projectA.id, title: 'Cible', worktree: { mode: 'new', branch: 'feature/cible' } })).json() as SessionDto;
    const [permission] = await a.db
      .insert(permissionRequests)
      .values({ sessionId: sessionA.id, toolName: 'Bash', toolInput: { command: 'ls' }, title: 'Exécuter une commande', status: 'pending' })
      .returning();
    const [operation] = await a.db
      .insert(operations)
      .values({ environmentId: serverA.environmentId, projectId: projectA.id, kind: 'fetch', status: 'succeeded', title: 'Récupération' })
      .returning();
    const [run] = await a.db
      .insert(commandRuns)
      .values({ environmentId: serverA.environmentId, projectId: projectA.id, worktreeId: sessionA.worktreeId, kind: 'custom', command: 'node -v', status: 'succeeded' })
      .returning();
    const sessionB = (await call(b, 'POST', '/v1/sessions', { projectId: projectB.id, title: 'Locale', worktree: { mode: 'new', branch: 'feature/locale' } })).json() as SessionDto;

    const snapshot = async () => ({
      session: (await a.db.select().from(sessions).where(eq(sessions.id, sessionA.id)))[0],
      worktree: (await a.db.select().from(worktrees).where(eq(worktrees.id, sessionA.worktreeId!)))[0],
      project: (await a.db.select().from(projects).where(eq(projects.id, projectA.id)))[0],
      permission: (await a.db.select().from(permissionRequests).where(eq(permissionRequests.id, permission!.id)))[0],
      operations: (await a.db.select({ id: operations.id }).from(operations).where(eq(operations.projectId, projectA.id))).length,
      runs: (await a.db.select({ id: commandRuns.id }).from(commandRuns).where(eq(commandRuns.projectId, projectA.id))).length,
      sessions: (await a.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.projectId, projectA.id))).length,
      // Nothing written on B's side either (no operation, run, worktree or session started by a probe).
      ofB: {
        operations: (await a.db.select({ id: operations.id }).from(operations).where(eq(operations.environmentId, serverB.environmentId))).length,
        runs: (await a.db.select({ id: commandRuns.id }).from(commandRuns).where(eq(commandRuns.environmentId, serverB.environmentId))).length,
        worktrees: (await a.db.select({ id: worktrees.id }).from(worktrees).where(eq(worktrees.environmentId, serverB.environmentId))).length,
        sessions: (await a.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.environmentId, serverB.environmentId))).length,
      },
    });
    const before = await snapshot();
    expect(existsSync(sessionA.worktree!.path)).toBe(true);

    const unknown = randomUUID();
    const author = { name: 'Camille Martin', email: 'camille@example.test' };
    const extraHeader = 'AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46amV0b24=';
    const cases: Array<{
      label: string;
      method: 'GET' | 'POST' | 'DELETE';
      url: (id: string) => string;
      body?: (id: string) => unknown;
      foreign: string;
      /** Status of an unknown id when it is not 404 (e.g. « no live process »). */
      status?: number;
    }> = [
      { label: 'getSession', method: 'GET', url: (id) => `/v1/sessions/${id}`, foreign: sessionA.id },
      { label: 'resumeSession', method: 'POST', url: (id) => `/v1/sessions/${id}/resume`, body: () => ({}), foreign: sessionA.id },
      { label: 'sendInstruction', method: 'POST', url: (id) => `/v1/sessions/${id}/instruction`, body: () => ({ text: 'bonjour' }), foreign: sessionA.id },
      { label: 'interruptSession', method: 'POST', url: (id) => `/v1/sessions/${id}/interrupt`, foreign: sessionA.id },
      { label: 'sessionTerminal', method: 'GET', url: (id) => `/v1/sessions/${id}/terminal`, foreign: sessionA.id },
      { label: 'sessionStream', method: 'GET', url: (id) => `/v1/sessions/${id}/stream`, foreign: sessionA.id },
      { label: 'operationStream', method: 'GET', url: (id) => `/v1/operations/${id}/stream`, foreign: operation!.id },
      { label: 'runStream', method: 'GET', url: (id) => `/v1/runs/${id}/stream`, foreign: run!.id },
      { label: 'fetchRepo', method: 'POST', url: (id) => `/v1/repos/${id}/fetch`, body: () => ({}), foreign: projectA.id },
      { label: 'pullRepo', method: 'POST', url: (id) => `/v1/repos/${id}/pull`, body: () => ({}), foreign: projectA.id },
      { label: 'repoStatus', method: 'GET', url: (id) => `/v1/repos/${id}/status`, foreign: projectA.id },
      { label: 'listBranches', method: 'GET', url: (id) => `/v1/repos/${id}/branches`, foreign: projectA.id },
      { label: 'createBranch', method: 'POST', url: (id) => `/v1/repos/${id}/branches`, body: () => ({ name: 'feature/intrus', checkout: true }), foreign: projectA.id },
      { label: 'checkoutBranch', method: 'POST', url: (id) => `/v1/repos/${id}/checkout`, body: () => ({ branch: 'main' }), foreign: projectA.id },
      { label: 'repoLog', method: 'GET', url: (id) => `/v1/repos/${id}/log?n=5`, foreign: projectA.id },
      { label: 'readClaudeMd', method: 'GET', url: (id) => `/v1/projects/${id}/claude-md`, foreign: projectA.id },
      { label: 'writeClaudeMd', method: 'POST', url: (id) => `/v1/projects/${id}/claude-md`, body: () => ({ content: '# Intrus\n' }), foreign: projectA.id },
      { label: 'worktreeDiff', method: 'GET', url: (id) => `/v1/worktrees/${id}/diff?path=README.md`, foreign: sessionA.worktreeId! },
      { label: 'stagePaths', method: 'POST', url: (id) => `/v1/worktrees/${id}/stage`, body: () => ({ paths: ['README.md'] }), foreign: sessionA.worktreeId! },
      { label: 'unstagePaths', method: 'POST', url: (id) => `/v1/worktrees/${id}/unstage`, body: () => ({ paths: ['README.md'] }), foreign: sessionA.worktreeId! },
      { label: 'commit', method: 'POST', url: (id) => `/v1/worktrees/${id}/commit`, body: () => ({ message: 'Intrus', author }), foreign: sessionA.worktreeId! },
      { label: 'push', method: 'POST', url: (id) => `/v1/worktrees/${id}/push`, body: () => ({ extraHeader }), foreign: sessionA.worktreeId! },
      { label: 'aheadBehind', method: 'GET', url: (id) => `/v1/worktrees/${id}/ahead-behind`, foreign: sessionA.worktreeId! },
      { label: 'fileTree', method: 'GET', url: (id) => `/v1/worktrees/${id}/tree`, foreign: sessionA.worktreeId! },
      { label: 'readFile', method: 'GET', url: (id) => `/v1/worktrees/${id}/file?path=README.md`, foreign: sessionA.worktreeId! },
      // B's own project, with a worktree of A.
      { label: 'repoStatus (own project, foreign worktree)', method: 'GET', url: (id) => `/v1/repos/${projectB.id}/status?worktreeId=${id}`, foreign: sessionA.worktreeId! },
      {
        label: 'createSession (own project, foreign worktree)',
        method: 'POST',
        url: () => '/v1/sessions',
        body: (id) => ({ projectId: projectB.id, worktree: { mode: 'existing', worktreeId: id } }),
        foreign: sessionA.worktreeId!,
      },
      {
        label: 'createRun (own project, foreign worktree)',
        method: 'POST',
        url: () => '/v1/runs',
        body: (id) => ({ projectId: projectB.id, worktreeId: id, kind: 'custom', command: 'node -v' }),
        foreign: sessionA.worktreeId!,
      },
      {
        label: 'writeClaudeMd (own project, foreign worktree)',
        method: 'POST',
        url: () => `/v1/projects/${projectB.id}/claude-md`,
        body: (id) => ({ content: '# Intrus\n', worktreeId: id }),
        foreign: sessionA.worktreeId!,
      },
      { label: 'sessionEvents', method: 'GET', url: (id) => `/v1/sessions/${id}/events`, foreign: sessionA.id },
      { label: 'stopSession', method: 'POST', url: (id) => `/v1/sessions/${id}/stop`, body: () => ({ force: true }), foreign: sessionA.id },
      { label: 'startSession', method: 'POST', url: (id) => `/v1/sessions/${id}/start`, body: () => ({}), foreign: sessionA.id },
      { label: 'announceSession', method: 'POST', url: (id) => `/v1/sessions/${id}/announce`, foreign: sessionA.id },
      { label: 'permissionDecision', method: 'POST', url: (id) => `/v1/permissions/${id}/decision`, body: () => ({ behavior: 'allow' }), foreign: permission!.id },
      { label: 'worktreeStatus', method: 'GET', url: (id) => `/v1/worktrees/${id}/status`, foreign: sessionA.worktreeId! },
      { label: 'worktreeChanges', method: 'GET', url: (id) => `/v1/worktrees/${id}/changes`, foreign: sessionA.worktreeId! },
      { label: 'removeWorktree', method: 'DELETE', url: (id) => `/v1/worktrees/${id}?force=1`, foreign: sessionA.worktreeId! },
      { label: 'shellTerminal', method: 'POST', url: () => '/v1/terminals', body: (id) => ({ kind: 'shell', worktreeId: id }), foreign: sessionA.worktreeId! },
      { label: 'repoSync', method: 'GET', url: (id) => `/v1/repos/${id}/sync`, foreign: projectA.id },
      { label: 'listWorktrees', method: 'GET', url: (id) => `/v1/repos/${id}/worktrees`, foreign: projectA.id },
      { label: 'createWorktree', method: 'POST', url: (id) => `/v1/repos/${id}/worktrees`, body: () => ({ branch: 'feature/intrus' }), foreign: projectA.id },
      { label: 'removeClone', method: 'DELETE', url: (id) => `/v1/repos/${id}/clone`, foreign: projectA.id },
      { label: 'createSession', method: 'POST', url: () => '/v1/sessions', body: (id) => ({ projectId: id, worktree: { mode: 'primary' } }), foreign: projectA.id },
      { label: 'createRun', method: 'POST', url: () => '/v1/runs', body: (id) => ({ projectId: id, kind: 'custom', command: 'node -v' }), foreign: projectA.id },
      { label: 'cloneRepo', method: 'POST', url: () => '/v1/repos/clone', body: (id) => ({ projectId: id, fullName: 'nuera-studio/alpha', destination: 'alpha-bis', installDeps: false }), foreign: projectA.id },
      { label: 'getOperation', method: 'GET', url: (id) => `/v1/operations/${id}`, foreign: operation!.id },
      { label: 'getRun', method: 'GET', url: (id) => `/v1/runs/${id}`, foreign: run!.id },
      { label: 'stopRun', method: 'DELETE', url: (id) => `/v1/runs/${id}`, foreign: run!.id },
      // A session id recorded on B's own commit must be one of B's sessions.
      {
        label: 'commit with a foreign session',
        method: 'POST',
        url: () => `/v1/worktrees/${sessionB.worktreeId}/commit`,
        body: (id) => ({ message: 'Essai', author: { name: 'Camille Martin', email: 'camille@example.test' }, sessionId: id }),
        foreign: sessionA.id,
      },
    ];
    for (const c of cases) {
      const foreign = await call(b, c.method, c.url(c.foreign), c.body?.(c.foreign));
      const missing = await call(b, c.method, c.url(unknown), c.body?.(unknown));
      expect(foreign.statusCode, c.label).toBe(c.status ?? 404);
      expect(missing.statusCode, c.label).toBe(foreign.statusCode);
      expect(foreign.json(), c.label).toEqual(missing.json());
    }
    expect(await snapshot()).toEqual(before);
    // Nothing left on B's disk either (no worktree, no clone).
    expect(existsSync(path.join(b.dirs.projects, 'alpha-bis'))).toBe(false);
  }, 300_000);

  it('runs every claude command of a server with its own Claude config dir', async () => {
    const statusA = (await call(a, 'GET', '/v1/claude/status?refresh=1')).json() as { state: string; auth: { email: string | null } | null };
    const statusB = (await call(b, 'GET', '/v1/claude/status?refresh=1')).json() as { state: string };
    expect(statusA).toMatchObject({ state: 'connected', auth: { email: 'ethan@example.test' } });
    expect(statusB.state).toBe('disconnected');
  });

  it('records who opened a terminal and gives a shell the Git identity of that account', async () => {
    const login = await call(a, 'POST', '/v1/terminals', { kind: 'claude-status', actorUserId: serverA.userId });
    expect(login.statusCode).toBe(200);
    const loginDto = login.json() as { id: string; ownerUserId: string | null; private: boolean };
    expect(loginDto).toMatchObject({ ownerUserId: serverA.userId, private: true });
    const listed = (await call(a, 'GET', '/v1/terminals')).json() as { terminals: Array<{ id: string; ownerUserId: string | null }> };
    expect(listed.terminals.find((t) => t.id === loginDto.id)?.ownerUserId).toBe(serverA.userId);
    expect((await call(a, 'DELETE', `/v1/terminals/${loginDto.id}`)).statusCode).toBe(200);

    const worktreesA = (await call(a, 'GET', `/v1/repos/${projectA.id}/worktrees`)).json() as { worktrees: Array<{ id: string; isPrimary: boolean }> };
    const primary = worktreesA.worktrees.find((w) => w.isPrimary)!;
    const shell = await call(a, 'POST', '/v1/terminals', {
      kind: 'shell',
      worktreeId: primary.id,
      actorUserId: serverA.userId,
      gitIdentity: { name: 'Ethan Martin', email: 'ethan@example.test' },
    });
    expect(shell.statusCode).toBe(200);
    const shellDto = shell.json() as { id: string; ownerUserId: string | null };
    expect(shellDto.ownerUserId).toBe(serverA.userId);
    const terminal = a.runner.services.terminals.get(shellDto.id);
    terminal.write('git var GIT_AUTHOR_IDENT\r');
    await waitFor(() => terminal.screenText().includes('Ethan Martin <ethan@example.test>'), { timeoutMs: 60_000, label: 'identité Git du shell' });
    expect((await call(a, 'DELETE', `/v1/terminals/${shellDto.id}`)).statusCode).toBe(200);
  }, 120_000);

  it('writes its heartbeat (versions, capabilities, database role) without touching its status', async () => {
    const [rowABefore] = await a.db.select().from(environments).where(eq(environments.id, serverA.environmentId));
    await b.runner.services.heartbeat();
    const [row] = await a.db.select().from(environments).where(eq(environments.id, serverB.environmentId));
    expect(row).toMatchObject({ status: 'active', runnerVersion: '0.0.0-test', contractVersion: RUNNER_CONTRACT_VERSION, backend: 'pty' });
    expect(row!.lastSeenAt).toBeInstanceOf(Date);
    // The test database is reached as the superuser: the admin console must warn about it.
    expect(row!.capabilities).toMatchObject({ platform: process.platform, claudeVersion: '2.1.999', database: { role: 'nuera', restricted: false } });
    // B's heartbeat never writes A's row.
    const [rowA] = await a.db.select().from(environments).where(eq(environments.id, serverA.environmentId));
    expect(rowA).toEqual(rowABefore);
  });

  it('refreshes last_seen_at every heartbeat period with the scheduler off, and stops on an identity change found later', async () => {
    const token = `test-runner-token-serveur-e-${Date.now().toString(36)}`;
    const otherToken = `test-runner-token-serveur-f-${Date.now().toString(36)}`;
    const serverE = await seedServer(a.db, { token, name: 'Serveur E' });
    const serverF = await seedServer(a.db, { token: otherToken, name: 'Serveur F' });
    const fatals: Error[] = [];
    const e = await startTestRunner({ token }, { runner: { heartbeatIntervalMs: 200, onFatal: (error) => fatals.push(error) } });
    extra.push(e);
    expect(e.runner.services.config.schedulerEnabled).toBe(false);
    const lastSeen = async () => (await a.db.select({ at: environments.lastSeenAt }).from(environments).where(eq(environments.id, serverE.environmentId)))[0]!.at;

    // A stale value (an old beat) is replaced by the next beat, with no scheduler running.
    const stale = new Date(Date.now() - 20 * 60_000);
    await a.db.update(environments).set({ lastSeenAt: stale }).where(eq(environments.id, serverE.environmentId));
    await waitFor(async () => ((await lastSeen())?.getTime() ?? 0) > Date.now() - 60_000, { timeoutMs: 30_000, label: 'battement périodique' });

    // The token now designates another server's row: the periodic re-read stops the runner (once).
    await a.db.update(environments).set({ tokenHash: hashToken(`${token}-revoque`) }).where(eq(environments.id, serverE.environmentId));
    await a.db.update(environments).set({ tokenHash: hashToken(token) }).where(eq(environments.id, serverF.environmentId));
    try {
      await waitFor(() => fatals.length > 0, { timeoutMs: 30_000, label: 'arrêt fatal' });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(fatals.map((error) => error.message)).toEqual(['Le jeton de ce runner désigne désormais un autre serveur : redémarrez le runner.']);
    } finally {
      await e.close().catch(() => undefined);
      extra.splice(extra.indexOf(e), 1);
      await a.db.update(environments).set({ tokenHash: hashToken(otherToken) }).where(eq(environments.id, serverF.environmentId));
    }
  }, 120_000);

  it('fetches in the background only the projects of its own server', async () => {
    const asked: string[] = [];
    const web = b.runner.services.web;
    const original = web.gitCredentials.bind(web);
    web.gitCredentials = async (payload) => {
      asked.push(payload.projectId);
      return null;
    };
    try {
      const [beforeA] = await a.db.select().from(projects).where(eq(projects.id, projectA.id));
      await b.runner.services.scheduler.fetchProjects();
      expect(asked).toContain(projectB.id);
      expect(asked).not.toContain(projectA.id);
      const [afterA] = await a.db.select().from(projects).where(eq(projects.id, projectA.id));
      expect(afterA).toEqual(beforeA);
    } finally {
      web.gitCredentials = original;
    }
  });

  it('keeps its availability under its own key', async () => {
    await a.runner.services.uptime.beat();
    const rowsOfA = () => a.db.select().from(uptimeDaily).where(eq(uptimeDaily.service, 'runner')).orderBy(uptimeDaily.day);
    const beforeA = await rowsOfA();
    expect(beforeA.length).toBeGreaterThan(0);
    await b.runner.services.uptime.beat();
    const report = (await call(b, 'GET', '/v1/system/uptime?days=7')).json() as { service: string; days: Array<{ upMinutes: number }> };
    expect(report.service).toBe(`runner:${serverB.environmentId}`);
    expect(report.days.at(-1)!.upMinutes).toBeGreaterThanOrEqual(1);
    // A gap detected by B is B's incident only.
    await a.db
      .update(uptimeDaily)
      .set({ lastBeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(uptimeDaily.service, `runner:${serverB.environmentId}`));
    expect(await b.runner.services.uptime.detectGap()).not.toBeNull();
    const [rowB] = await a.db.select().from(uptimeDaily).where(eq(uptimeDaily.service, `runner:${serverB.environmentId}`)).orderBy(desc(uptimeDaily.day)).limit(1);
    expect(rowB!.incidents).toHaveLength(1);
    expect(await rowsOfA()).toEqual(beforeA);
  });

  it('refuses new work on a suspended server, keeps reading and stopping', async () => {
    const created = (await call(b, 'POST', '/v1/sessions', { projectId: projectB.id, title: 'Avant suspension', worktree: { mode: 'new', branch: 'feature/avant' } })).json() as SessionDto;
    await a.db.update(environments).set({ status: 'suspended' }).where(eq(environments.id, serverB.environmentId));
    await b.runner.services.environment.refresh();
    try {
      expect(((await call(b, 'GET', '/v1/health')).json() as { state: string }).state).toBe('disabled');
      const disabled = {
        error: {
          code: 'FORBIDDEN',
          reason: 'ENVIRONMENT_DISABLED',
          message: 'Ce serveur est désactivé : aucune nouvelle session, aucun clonage ni aucune commande ne peut démarrer.',
        },
      };
      const refused = [
        await call(b, 'POST', '/v1/sessions', { projectId: projectB.id, worktree: { mode: 'primary' } }),
        await call(b, 'POST', `/v1/sessions/${created.id}/start`, {}),
        await call(b, 'POST', `/v1/sessions/${created.id}/instruction`, { text: 'bonjour' }),
        await call(b, 'POST', '/v1/runs', { projectId: projectB.id, kind: 'custom', command: 'node -v' }),
        await call(b, 'POST', `/v1/repos/${projectB.id}/worktrees`, { branch: 'feature/apres' }),
        await call(b, 'POST', '/v1/terminals', { kind: 'shell', worktreeId: created.worktreeId }),
        await call(b, 'POST', '/v1/repos/clone', { projectId: projectB.id, fullName: 'nuera-studio/beta', destination: 'beta-bis', installDeps: false }),
      ];
      for (const res of refused) {
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual(disabled);
      }
      // Reading and stopping stay possible.
      expect((await call(b, 'GET', '/v1/sessions')).statusCode).toBe(200);
      expect((await call(b, 'GET', `/v1/repos/${projectB.id}/worktrees`)).statusCode).toBe(200);
      expect((await call(b, 'POST', `/v1/sessions/${created.id}/stop`, { force: true })).statusCode).toBe(200);
      const [row] = await a.db.select().from(environments).where(eq(environments.id, serverB.environmentId));
      expect(row!.status).toBe('suspended');
    } finally {
      await a.db.update(environments).set({ status: 'active' }).where(eq(environments.id, serverB.environmentId));
      await b.runner.services.environment.refresh();
    }
    expect(((await call(b, 'GET', '/v1/health')).json() as { state: string }).state).toBe('ready');
  });

  it('reconciles only its own sessions, operations and runs when it restarts', async () => {
    const seedLive = async (server: TestServer, project: typeof projects.$inferSelect) => {
      const [session] = await a.db
        .insert(sessions)
        .values({ id: randomUUID(), projectId: project.id, environmentId: server.environmentId, title: 'Vivante', status: 'running', backend: 'pty', startedAt: new Date() })
        .returning();
      const [operation] = await a.db
        .insert(operations)
        .values({ environmentId: server.environmentId, projectId: project.id, kind: 'fetch', status: 'running', startedAt: new Date() })
        .returning();
      const [run] = await a.db
        .insert(commandRuns)
        .values({ environmentId: server.environmentId, projectId: project.id, kind: 'custom', command: 'node serveur.js', status: 'running' })
        .returning();
      return { session: session!.id, operation: operation!.id, run: run!.id };
    };
    const liveA = await seedLive(serverA, projectA);
    const liveB = await seedLive(serverB, projectB);

    const dirs = b.dirs;
    await b.close({ keepFolders: true });
    b = await startTestRunner({ token: TOKEN_B, claudeConfigDir: claudeB }, { dirs });

    const statusOf = async (ids: typeof liveA) => ({
      session: (await a.db.select({ s: sessions.status }).from(sessions).where(eq(sessions.id, ids.session)))[0]!.s,
      operation: (await a.db.select({ s: operations.status }).from(operations).where(eq(operations.id, ids.operation)))[0]!.s,
      run: (await a.db.select({ s: commandRuns.status }).from(commandRuns).where(eq(commandRuns.id, ids.run)))[0]!.s,
    });
    expect(await statusOf(liveB)).toEqual({ session: 'interrupted', operation: 'failed', run: 'stopped' });
    expect(await statusOf(liveA)).toEqual({ session: 'running', operation: 'running', run: 'running' });
    // Leave A's rows as A's own restart would.
    await a.db.update(sessions).set({ status: 'interrupted' }).where(eq(sessions.id, liveA.session));
    await a.db.update(operations).set({ status: 'failed' }).where(eq(operations.id, liveA.operation));
    await a.db.update(commandRuns).set({ status: 'stopped' }).where(eq(commandRuns.id, liveA.run));
  }, 300_000);

  it('waits in standby with an unknown token, then serves once its server is registered', async () => {
    const token = `test-runner-token-inconnu-${Date.now().toString(36)}`;
    const c = await startTestRunner({ token });
    extra.push(c);
    const health = HealthResponseSchema.parse((await call(c, 'GET', '/v1/health')).json());
    expect(health).toMatchObject({ state: 'unregistered', environment: null, contractVersion: RUNNER_CONTRACT_VERSION });
    const refused = await call(c, 'GET', '/v1/sessions');
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({
      error: {
        code: 'UPSTREAM',
        reason: 'ENVIRONMENT_UNREGISTERED',
        message: `Ce runner n'est rattaché à aucun serveur. Enregistrez-le depuis Administration, rubrique Serveurs (empreinte du jeton : ${tokenFingerprint(token)}).`,
      },
    });
    // Nothing reconciled, no marker claimed while unregistered.
    expect(existsSync(path.join(c.dirs.data, MARKER_FILE))).toBe(false);

    const serverC = await seedServer(a.db, { token, name: 'Serveur C' });
    await c.runner.ready;
    expect(HealthResponseSchema.parse((await call(c, 'GET', '/v1/health')).json())).toMatchObject({ state: 'ready', environment: { id: serverC.environmentId, name: 'Serveur C' } });
    expect((await call(c, 'GET', '/v1/sessions')).statusCode).toBe(200);
    for (const dir of [c.dirs.data, c.dirs.projects]) {
      expect(JSON.parse(readFileSync(path.join(dir, MARKER_FILE), 'utf8'))).toMatchObject({ environmentId: serverC.environmentId, name: 'Serveur C' });
    }

    // Retired while serving: back to health only (nothing is killed).
    await a.db.update(environments).set({ status: 'retired' }).where(eq(environments.id, serverC.environmentId));
    await c.runner.services.environment.refresh();
    expect(HealthResponseSchema.parse((await call(c, 'GET', '/v1/health')).json())).toMatchObject({ state: 'unregistered', environment: null });
    expect(((await call(c, 'GET', '/v1/sessions')).json() as ErrorBody).error.reason).toBe('ENVIRONMENT_UNREGISTERED');
  }, 300_000);

  it('refuses a folder that belongs to another server, and a wrong NUERA_ENVIRONMENT_ID', async () => {
    const token = `test-runner-token-serveur-d-${Date.now().toString(36)}`;
    const serverD = await seedServer(a.db, { token, name: 'Serveur D' });
    const attempt = async (overrides: Parameters<typeof testConfig>[1], mark: 'data' | 'projects' | null) => {
      const root = tmpDir('marker');
      const dirs = { projects: path.join(root, 'projects'), data: path.join(root, 'data'), remotes: path.join(root, 'remotes') };
      for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
      if (mark) {
        const marker = { environmentId: serverA.environmentId, name: 'VPS-3', createdAt: new Date().toISOString() };
        writeFileSync(path.join(mark === 'data' ? dirs.data : dirs.projects, MARKER_FILE), JSON.stringify(marker));
      }
      const runner = await buildRunner(testConfig(dirs, { token, ...overrides }), { logger: silentLogger, standbyRetryMs: 200 });
      try {
        await runner.start({ listen: false });
        return { ok: true as const, dirs, environment: runner.services.environment.ref() };
      } catch (error) {
        return { ok: false as const, dirs, message: (error as Error).message };
      } finally {
        await runner.close();
        cleanup(root);
      }
    };
    const data = await attempt({}, 'data');
    expect(data).toMatchObject({ ok: false, message: `Le dossier de données ${data.dirs.data} appartient au serveur « VPS-3 » : donnez un dossier propre à ce runner (NUERA_DATA_DIR).` });
    const projectsRoot = await attempt({}, 'projects');
    expect(projectsRoot).toMatchObject({
      ok: false,
      message: `Le dossier des projets ${projectsRoot.dirs.projects} appartient au serveur « VPS-3 » : donnez un dossier propre à ce runner (NUERA_PROJECTS_ROOT).`,
    });
    expect(await attempt({ environmentId: serverA.environmentId }, null)).toMatchObject({
      ok: false,
      message: 'NUERA_ENVIRONMENT_ID ne correspond pas au serveur de ce jeton : vérifiez la configuration du runner.',
    });
    expect(await attempt({ environmentId: serverD.environmentId }, null)).toMatchObject({ ok: true, environment: { id: serverD.environmentId, name: 'Serveur D' } });
  }, 300_000);

  it('lets one runner per server hold the lease (a second one waits for the first to stop)', async () => {
    const second = await startTestRunner({ token: TOKEN_B });
    extra.push(second);
    expect(HealthResponseSchema.parse((await call(second, 'GET', '/v1/health')).json())).toMatchObject({
      state: 'starting',
      environment: { id: serverB.environmentId, name: 'Serveur B' },
    });
    const refused = await call(second, 'GET', '/v1/sessions');
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({
      error: { code: 'UPSTREAM', reason: 'ENVIRONMENT_STARTING', message: 'Un autre runner du serveur « Serveur B » est encore actif : attente de son arrêt…' },
    });
    // The first runner still serves, untouched.
    expect((await call(b, 'GET', '/v1/sessions')).statusCode).toBe(200);

    await b.close();
    await second.runner.ready;
    expect(((await call(second, 'GET', '/v1/health')).json() as { state: string }).state).toBe('ready');
    const list = (await call(second, 'GET', '/v1/sessions')).json() as { sessions: SessionDto[] };
    const ids = list.sessions.map((s) => s.id);
    const own = await a.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.environmentId, serverB.environmentId), inArray(sessions.status, [...LIVE_SESSION_STATUSES, 'new'])));
    expect(own.length).toBeGreaterThan(0);
    expect(ids.sort()).toEqual(own.map((r) => r.id).sort());
    // b is closed: the last runner of B is closed by afterAll through `extra`.
    b = second;
    extra.splice(extra.indexOf(second), 1);
  }, 300_000);

  it('authenticates with its own token only', async () => {
    const res = await a.runner.api.inject({ method: 'GET', url: '/v1/sessions', headers: authFor(TOKEN_B) });
    expect(res.statusCode).toBe(401);
  });
});
