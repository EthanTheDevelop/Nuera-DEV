import { auditLog, environmentSpaces, environments, notifications, projects } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeWebTestDb, prepareTenancyDatabase, useTestEncryptionKey } from './test/db';
import { startFakeRunner, terminalDto, type FakeRunner } from './test/fake-runner';
import { createTestAccount, createTestResources, resetTenancyCaches, truncateTenancy, type TestAccount, type TestResources } from './test/fixtures';

/*
 * Shared servers (lot P1): one server works for several accounts. Each keeps its space — an id of
 * the other account's space answers EXACTLY like an unknown one, without any runner call — and its
 * own Claude Code connection (the account rides along every Claude call to the runner). Events of
 * the global stream are kept for their own space only; administration adds and removes accounts
 * under its guards, journalled.
 */

// The runner is told about account changes in the background: not in these tests (exact request lists).
process.env.NUERA_CLAUDE_CONFIG_PUSH = 'off';

const scope = await import('./scope');
const context = await import('./context');
const { db } = await import('@/server/db');
const admin = await import('@/server/admin');
const { spaceEventLookups, spaceFrameFilter } = await import('@/server/runner/event-scope');
const { eventSpaceOfCaller } = await import('./runner-scope');
const { runnerPayload } = await import('@/server/claude-config/effective');
const { getRunnerForEnvironment } = await import('@/server/runner/client');
const { invalidateRunnerEndpoint } = await import('@/server/runner/config');

let runner: FakeRunner;
let a: TestAccount;
let c: TestAccount;
let resA: TestResources;
let resC: TestResources;

const actorOf = (target: TestAccount) => ({ id: target.user.id, name: target.user.name, email: target.user.email, role: target.user.role });

async function failure(promise: Promise<unknown>): Promise<{ code: string; status: number; message: string }> {
  const error = (await promise.then(
    () => {
      throw new Error('aucune erreur');
    },
    (caught: unknown) => caught,
  )) as { code: string; status: number; message: string };
  return { code: error.code, status: error.status, message: error.message };
}

const frame = (event: Record<string, unknown>) => `id: 7\ndata: ${JSON.stringify({ seq: 7, at: '2026-11-06T10:00:00.000Z', ...event })}\n\n`;

beforeAll(async () => {
  await prepareTenancyDatabase('partage');
  useTestEncryptionKey();
  runner = await startFakeRunner();
});

afterAll(async () => {
  await runner.close();
  await closeWebTestDb();
});

beforeEach(async () => {
  await truncateTenancy();
  scope.invalidateTerminalScope();
  a = await createTestAccount({ role: 'owner', name: 'Camille Laurent', environment: { configSource: 'db', isDefault: false, url: runner.url, name: 'VPS-3' } });
  await db.update(environments).set({ contractVersion: 3 }).where(eq(environments.id, a.environment!.id));
  const guest = await createTestAccount({ role: 'member', name: 'Hugo Martin', environment: false });
  await admin.addServerAccount(actorOf(a), a.environment!.id, { userId: guest.user.id });
  resetTenancyCaches();
  const ctx = await context.resolveContext(guest.user);
  c = { ...guest, environment: ctx.environment, ctx };
  resA = await createTestResources(a, 'nuera-os');
  // Same repository on the same server, for the other account (its own folder, its own slug).
  resC = await createTestResources(c, 'nuera-os-2');
  await db.update(projects).set({ githubFullName: 'nuera-studio/nuera-os' }).where(eq(projects.id, resC.projectId));
  runner.requests.length = 0;
});

describe('contexte et cloisonnement sur un serveur partagé', () => {
  it("donne au compte ajouté le serveur de l'autre compte, sans en être le premier compte", async () => {
    expect(c.ctx.environment).toMatchObject({ id: a.environment!.id, name: 'VPS-3', primary: false, accounts: 2 });
    resetTenancyCaches();
    expect((await context.resolveContext(a.user)).environment).toMatchObject({ primary: true, accounts: 2 });
  });

  const cases = [
    ['scopeOfProject', 'projectId'],
    ['scopeOfSession', 'sessionId'],
    ['scopeOfWorktree', 'worktreeId'],
    ['scopeOfRun', 'runId'],
    ['scopeOfOperation', 'operationId'],
    ['scopeOfOperation', 'serverOperationId'],
    ['scopeOfPermission', 'permissionId'],
  ] as const;
  for (const [fn, key] of cases) {
    it(`${fn} (${key}) : la ressource de l'autre compte du même serveur répond comme une inconnue`, async () => {
      const helper = scope[fn] as (ctx: TestAccount['ctx'], id: string) => Promise<{ environmentId: string }>;
      const unknown = await failure(helper(c.ctx, '0b9d8c7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e'));
      expect(unknown.status).toBe(404);
      expect(await failure(helper(c.ctx, resA[key]))).toEqual(unknown);
      // The first account cannot reach the other's either (an operation without project is its server's).
      const theirs = key === 'serverOperationId' ? resC.operationId : resC[key];
      expect(await failure(helper(a.ctx, theirs))).toEqual(await failure(helper(a.ctx, '0b9d8c7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e')));
      expect((await helper(c.ctx, theirs)).environmentId).toBe(a.environment!.id);
      expect(runner.requests).toHaveLength(0);
    });
  }

  it("refuse le terminal de l'autre compte, et un terminal sans compte sur un serveur partagé", async () => {
    const TERMINAL = 'term_0123456789ab';
    const unknown = { code: 'NOT_FOUND', status: 404, message: 'Terminal introuvable ou fermé.' };
    runner.handle((_req, res) => runner.json(res, 200, { ...terminalDto({ id: TERMINAL, kind: 'claude-login' }), spaceId: a.space.id }));
    expect(await failure(scope.scopeOfTerminal(c.ctx, TERMINAL))).toEqual(unknown);
    runner.handle((_req, res) => runner.json(res, 200, terminalDto({ id: TERMINAL, kind: 'claude-login' })));
    expect(await failure(scope.scopeOfTerminal(c.ctx, TERMINAL))).toEqual(unknown);
    runner.handle((_req, res) => runner.json(res, 200, terminalDto({ id: TERMINAL, worktreeId: resA.worktreeId })));
    expect(await failure(scope.scopeOfTerminal(c.ctx, TERMINAL))).toEqual(unknown);
    runner.handle((_req, res) => runner.json(res, 200, { ...terminalDto({ id: TERMINAL, kind: 'claude-login', ownerUserId: c.user.id }), spaceId: c.space.id }));
    await expect(scope.scopeOfTerminal(c.ctx, TERMINAL)).resolves.toMatchObject({ terminalId: TERMINAL });
  });
});

describe('flux global : seulement les événements de son espace', () => {
  it('garde les événements de ses projets, son statut Claude et la charge du serveur', async () => {
    const forC = spaceFrameFilter({ spaceId: c.space.id, lookups: spaceEventLookups({ spaceId: c.space.id, environmentId: a.environment!.id }) });
    const forA = spaceFrameFilter({ spaceId: a.space.id, lookups: spaceEventLookups({ spaceId: a.space.id, environmentId: a.environment!.id }) });
    const sessionOf = (projectId: string, sessionId: string) => frame({ type: 'session.status', data: { sessionId, projectId, status: 'running' } });
    expect(await forC(sessionOf(resA.projectId, resA.sessionId))).toBe(false);
    expect(await forC(sessionOf(resC.projectId, resC.sessionId))).toBe(true);
    expect(await forA(sessionOf(resC.projectId, resC.sessionId))).toBe(false);
    expect(await forC(frame({ type: 'session.permission', data: { sessionId: resA.sessionId, permission: {} } }))).toBe(false);
    expect(await forC(frame({ type: 'session.permission', data: { sessionId: resC.sessionId, permission: {} } }))).toBe(true);
    expect(await forC(frame({ type: 'run.status', data: { run: { id: resA.runId, projectId: resA.projectId } } }))).toBe(false);
    expect(await forC(frame({ type: 'claude.status', data: { state: 'connected', spaceId: a.space.id } }))).toBe(false);
    expect(await forC(frame({ type: 'claude.status', data: { state: 'disconnected', spaceId: c.space.id } }))).toBe(true);
    // An older runner (no account in the status) is never relayed on a shared server.
    expect(await forC(frame({ type: 'claude.status', data: { state: 'connected' } }))).toBe(false);
    expect(await forC(frame({ type: 'system.metrics', data: { cpuPercent: 12 } }))).toBe(true);
    expect(await forC('data: {"seq":0,"type":"heartbeat","at":"2026-11-06T10:00:00.000Z","data":{}}\n\n')).toBe(true);
    const serverOperation = frame({ type: 'operation.progress', data: { operation: { id: resA.serverOperationId, projectId: null, sessionId: null } } });
    expect(await forC(serverOperation)).toBe(false);
    expect(await forA(serverOperation)).toBe(true);
    expect(await forC(frame({ type: 'notification.created', data: { projectId: null, sessionId: null, title: 'x' } }))).toBe(false);
    expect(await forC('data: pas du json\n\n')).toBe(false);
  });
});

describe('rappels du runner et configuration commune par compte', () => {
  it("adresse la notification d'une session au compte de cette session", async () => {
    const caller = { id: a.environment!.id, spaceId: a.space.id };
    expect(await eventSpaceOfCaller(caller, { sessionId: resC.sessionId })).toBe(c.space.id);
    expect(await eventSpaceOfCaller(caller, { projectId: resA.projectId })).toBe(a.space.id);
    expect(await eventSpaceOfCaller(caller, {})).toBe(a.space.id);
  });

  it("sert à chaque compte sa configuration, jamais celle d'un compte d'un autre serveur", async () => {
    const caller = { id: a.environment!.id, spaceId: a.space.id };
    await expect(runnerPayload(caller, { have: [], spaceId: c.space.id })).resolves.toMatchObject({ revision: expect.any(Number) });
    const stranger = await createTestAccount({ role: 'member', environment: { configSource: 'db', url: runner.url, name: 'VPS-9' } });
    await expect(runnerPayload(caller, { have: [], spaceId: stranger.space.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuse tout appel (sauf la santé) à un runner trop ancien pour un serveur partagé', async () => {
    await db.update(environments).set({ contractVersion: 2 }).where(eq(environments.id, a.environment!.id));
    invalidateRunnerEndpoint(a.environment!.id);
    await expect(getRunnerForEnvironment(a.environment!.id).claudeStatus({ query: { refresh: false, spaceId: c.space.id } })).rejects.toMatchObject({
      code: 'UPSTREAM',
      reason: 'RUNNER_OUTDATED',
    });
    expect(runner.requests).toHaveLength(0);
    await db.update(environments).set({ contractVersion: 3 }).where(eq(environments.id, a.environment!.id));
    invalidateRunnerEndpoint(a.environment!.id);
    runner.handle((_req, res) => runner.json(res, 200, { checkedAt: '2026-11-06T10:00:00.000Z', installed: true, version: '2.1.0', auth: null, state: 'disconnected', agents: null, error: null, spaceId: c.space.id }));
    await getRunnerForEnvironment(a.environment!.id).claudeStatus({ query: { refresh: false, spaceId: c.space.id } });
    expect(runner.requests.at(-1)?.path).toContain(`spaceId=${c.space.id}`);
  });
});

describe("administration des comptes d'un serveur", () => {
  it('ajoute et retire un compte sous ses gardes, journalisé', async () => {
    const view = await admin.getServer(actorOf(a), a.environment!.id);
    expect(view.accounts.map((account) => [account.id, account.primary])).toEqual([
      [a.user.id, true],
      [c.user.id, false],
    ]);
    // Already on it, a pending server, an older runner: refused.
    await expect(admin.addServerAccount(actorOf(a), a.environment!.id, { userId: c.user.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    const other = await createTestAccount({ role: 'member', name: 'Lina Moreau', environment: false });
    await db.update(environments).set({ contractVersion: 2 }).where(eq(environments.id, a.environment!.id));
    await expect(admin.addServerAccount(actorOf(a), a.environment!.id, { userId: other.user.id })).rejects.toMatchObject({ code: 'CONFLICT', reason: 'RUNNER_OUTDATED' });
    await db.update(environments).set({ contractVersion: 3 }).where(eq(environments.id, a.environment!.id));
    // The first account never leaves its server; an account with projects there neither.
    await expect(admin.removeServerAccount(actorOf(a), a.environment!.id, a.user.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(admin.removeServerAccount(actorOf(a), a.environment!.id, c.user.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await db.delete(projects).where(eq(projects.spaceId, c.space.id));
    runner.handle((_req, res) => runner.json(res, 200, { removed: true, signedOut: true }));
    const after = await admin.removeServerAccount(actorOf(a), a.environment!.id, c.user.id);
    expect(after.accounts.map((account) => account.id)).toEqual([a.user.id]);
    expect(runner.requests.at(-1)).toMatchObject({ method: 'POST', path: `/v1/claude/accounts/${c.space.id}/forget` });
    expect(await db.select().from(environmentSpaces).where(and(eq(environmentSpaces.environmentId, a.environment!.id), eq(environmentSpaces.spaceId, c.space.id)))).toEqual([]);
    const actions = (await db.select({ action: auditLog.action, subject: auditLog.subjectUserId }).from(auditLog)).filter((row) => row.action.startsWith('admin.server_account'));
    expect(actions).toEqual(
      expect.arrayContaining([
        { action: 'admin.server_account_added', subject: c.user.id },
        { action: 'admin.server_account_removed', subject: c.user.id },
      ]),
    );
    // Each account was told (the added one: connect its own Claude Code).
    const told = await db.select({ userId: notifications.userId, title: notifications.title }).from(notifications);
    expect(told).toEqual(expect.arrayContaining([{ userId: c.user.id, title: 'Vous travaillez désormais sur le serveur VPS-3.' }]));
  });
});
