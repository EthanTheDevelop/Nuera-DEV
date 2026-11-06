import { auditLog, projects } from '@nuera/db/schema';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeWebTestDb, prepareTenancyDatabase, useTestEncryptionKey } from './test/db';
import { startFakeRunner, terminalDto, type FakeRunner } from './test/fake-runner';
import type { ResourceScope, ScopeOptions } from './scope';
import { createTestAccount, createTestResources, truncateTenancy, type TestAccount, type TestResources } from './test/fixtures';

/*
 * Resource scoping: every helper answers its resource for its own space, and EXACTLY the
 * « unknown id » NOT_FOUND (same message, same status) for an id of another space — without any
 * runner call. Terminals are checked on the runner of ctx's server, then by owner/worktree/session.
 */

const scope = await import('./scope');
const { db } = await import('@/server/db');

let runnerA: FakeRunner;
let runnerB: FakeRunner;
let a: TestAccount;
let b: TestAccount;
let resA: TestResources;
let resB: TestResources;

beforeAll(async () => {
  await prepareTenancyDatabase('scope');
  useTestEncryptionKey();
  runnerA = await startFakeRunner();
  runnerB = await startFakeRunner();
});

afterAll(async () => {
  await runnerA.close();
  await runnerB.close();
  await closeWebTestDb();
});

beforeEach(async () => {
  await truncateTenancy();
  scope.invalidateTerminalScope();
  a = await createTestAccount({ role: 'owner', environment: { configSource: 'db', isDefault: false, url: runnerA.url, name: 'VPS-3' } });
  b = await createTestAccount({ role: 'member', environment: { configSource: 'db', url: runnerB.url, name: 'VPS-4' } });
  resA = await createTestResources(a, 'nuera-os');
  resB = await createTestResources(b, 'nuera-os');
  runnerA.requests.length = 0;
  runnerB.requests.length = 0;
});

async function failure(promise: Promise<unknown>): Promise<{ code: string; status: number; message: string; untouched?: string }> {
  const error = (await promise.then(
    () => {
      throw new Error('aucune erreur');
    },
    (caught: unknown) => caught,
  )) as { code: string; status: number; message: string; untouched?: string };
  return { code: error.code, status: error.status, message: error.message, ...(error.untouched ? { untouched: error.untouched } : {}) };
}

const UNKNOWN = '0b9d8c7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e';

describe('scope helpers', () => {
  const cases = [
    { name: 'project', fn: 'scopeOfProject', key: 'projectId', message: 'Projet introuvable : il a peut-être été retiré.' },
    { name: 'session', fn: 'scopeOfSession', key: 'sessionId', message: 'Session introuvable.' },
    { name: 'worktree', fn: 'scopeOfWorktree', key: 'worktreeId', message: 'Worktree introuvable.' },
    { name: 'run', fn: 'scopeOfRun', key: 'runId', message: 'Lancement introuvable.' },
    { name: 'operation', fn: 'scopeOfOperation', key: 'operationId', message: 'Opération introuvable.' },
    { name: 'operation without project', fn: 'scopeOfOperation', key: 'serverOperationId', message: 'Opération introuvable.' },
    { name: 'permission', fn: 'scopeOfPermission', key: 'permissionId', message: "Demande d'autorisation introuvable." },
  ] as const;

  for (const entry of cases) {
    it(`${entry.name}: own → scope of its server; foreign, unknown or malformed → identical NOT_FOUND`, async () => {
      const helper = scope[entry.fn] as (ctx: TestAccount['ctx'], id: string, options?: ScopeOptions) => Promise<ResourceScope>;
      const own = await helper(b.ctx, resB[entry.key]);
      expect(own).toMatchObject({ spaceId: b.space.id, environmentId: b.environment!.id, environmentName: 'VPS-4' });
      expect((await own.endpoint()).baseUrl).toBe(runnerB.url);

      const unknown = await failure(helper(b.ctx, UNKNOWN));
      expect(unknown).toEqual({ code: 'NOT_FOUND', status: 404, message: entry.message });
      expect(await failure(helper(b.ctx, resA[entry.key]))).toEqual(unknown);
      expect(await failure(helper(b.ctx, 'pas-un-uuid'))).toEqual(unknown);
      // A's own view still works: the refusal was about B.
      expect((await helper(a.ctx, resA[entry.key])).environmentId).toBe(a.environment!.id);

      expect(runnerA.requests).toHaveLength(0);
      expect(runnerB.requests).toHaveLength(0);
    });
  }

  it('keep the caller-specific copy when one is given', async () => {
    const options = { notFound: 'Projet introuvable.', untouched: "Rien n'a été lancé." };
    const unknown = await failure(scope.scopeOfProject(b.ctx, UNKNOWN, options));
    expect(unknown).toEqual({ code: 'NOT_FOUND', status: 404, message: 'Projet introuvable.', untouched: "Rien n'a été lancé." });
    expect(await failure(scope.scopeOfProject(b.ctx, resA.projectId, options))).toEqual(unknown);
  });

  it('expose what callers need for their state checks', async () => {
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, resB.projectId));
    const project = await scope.scopeOfProject(b.ctx, resB.projectId);
    expect(project.projectArchivedAt).toBeInstanceOf(Date);
    const session = await scope.scopeOfSession(b.ctx, resB.sessionId);
    expect(session).toMatchObject({ projectId: resB.projectId, worktreeId: resB.worktreeId });
    const worktree = await scope.scopeOfWorktree(b.ctx, resB.worktreeId);
    expect(worktree).toMatchObject({ projectId: resB.projectId, worktreeRemovedAt: null });
    const permission = await scope.scopeOfPermission(b.ctx, resB.permissionId);
    expect(permission).toMatchObject({ sessionId: resB.sessionId, projectId: resB.projectId });
    const operation = await scope.scopeOfOperation(b.ctx, resB.serverOperationId);
    expect(operation.projectId).toBeNull();
  });

  it('send runner calls to the server holding the resource', async () => {
    runnerB.handle((_req, res) => runnerB.json(res, 200, { terminalId: null, live: false }));
    const session = await scope.scopeOfSession(b.ctx, resB.sessionId);
    await session.runner.sessionTerminal({ params: { sessionId: resB.sessionId } });
    expect(runnerB.requests.map((r) => r.path)).toEqual([`/v1/sessions/${resB.sessionId}/terminal`]);
    expect(runnerB.requests[0]!.authorization).toBe(`Bearer ${b.token}`);
    expect(runnerA.requests).toHaveLength(0);
  });
});

describe('ofSpace / inSpace', () => {
  it('limit a list to the space of ctx', async () => {
    const rows = await db.select({ id: projects.id }).from(projects).where(scope.ofSpace(b.ctx));
    expect(rows.map((r) => r.id)).toEqual([resB.projectId]);
    const named = await db
      .select({ id: projects.id })
      .from(projects)
      .where(scope.ofSpace(a.ctx, eq(projects.slug, 'nuera-os'), undefined));
    expect(named.map((r) => r.id)).toEqual([resA.projectId]);
    const viaColumn = await db.select({ id: projects.id }).from(projects).where(scope.inSpace(projects.spaceId, b.ctx));
    expect(viaColumn).toHaveLength(1);
  });
});

describe('scopeOfTerminal', () => {
  const TERMINAL = 'term_0123456789ab';

  it('accepts a terminal of the account on its server', async () => {
    runnerB.handle((_req, res) => runnerB.json(res, 200, terminalDto({ id: TERMINAL, ownerUserId: b.user.id, worktreeId: resB.worktreeId })));
    const found = await scope.scopeOfTerminal(b.ctx, TERMINAL);
    expect(found).toMatchObject({ terminalId: TERMINAL, environmentId: b.environment!.id });
    expect(runnerB.requests.map((r) => r.path)).toEqual([`/v1/terminals/${TERMINAL}`]);
    expect(runnerA.requests).toHaveLength(0);
  });

  it('refuses identically: unknown, another owner, a worktree or session of another space, no server', async () => {
    runnerB.handle((_req, res) => runnerB.json(res, 404, { error: { code: 'NOT_FOUND', message: 'Terminal introuvable ou fermé.' } }));
    const unknown = await failure(scope.scopeOfTerminal(b.ctx, TERMINAL));
    expect(unknown).toEqual({ code: 'NOT_FOUND', status: 404, message: 'Terminal introuvable ou fermé.' });

    runnerB.handle((_req, res) => runnerB.json(res, 200, terminalDto({ id: TERMINAL, ownerUserId: a.user.id })));
    expect(await failure(scope.scopeOfTerminal(b.ctx, TERMINAL))).toEqual(unknown);

    runnerB.handle((_req, res) => runnerB.json(res, 200, terminalDto({ id: TERMINAL, ownerUserId: null, worktreeId: resA.worktreeId })));
    expect(await failure(scope.scopeOfTerminal(b.ctx, TERMINAL))).toEqual(unknown);

    runnerB.handle((_req, res) => runnerB.json(res, 200, terminalDto({ id: TERMINAL, kind: 'session', sessionId: resA.sessionId })));
    expect(await failure(scope.scopeOfTerminal(b.ctx, TERMINAL))).toEqual(unknown);

    expect(await failure(scope.scopeOfTerminal(b.ctx, 'x'))).toEqual(unknown);
    const before = runnerB.requests.length;
    const lonely = await createTestAccount({ environment: false });
    expect(await failure(scope.scopeOfTerminal(lonely.ctx, TERMINAL))).toEqual(unknown);
    expect(runnerB.requests).toHaveLength(before);
    expect(runnerA.requests).toHaveLength(0);
  });

  it('accepts a terminal without owner (older runner, login terminal) on the space server', async () => {
    runnerB.handle((_req, res) => runnerB.json(res, 200, terminalDto({ id: TERMINAL, kind: 'claude-login' })));
    await expect(scope.scopeOfTerminal(b.ctx, TERMINAL)).resolves.toMatchObject({ terminalId: TERMINAL });
  });

  it('reuses a positive verdict for keystrokes, never a negative one', async () => {
    runnerB.handle((_req, res) => runnerB.json(res, 200, terminalDto({ id: TERMINAL, ownerUserId: b.user.id })));
    await scope.scopeOfTerminalInput(b.ctx, TERMINAL);
    await scope.scopeOfTerminalInput(b.ctx, TERMINAL);
    expect(runnerB.requests).toHaveLength(1);

    // Another account on the same server never inherits B's verdict.
    const intruder = { ...b.ctx, user: { ...b.ctx.user, id: 'someone-else' } };
    await expect(scope.scopeOfTerminalInput(intruder, TERMINAL)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(runnerB.requests).toHaveLength(2);
    scope.invalidateTerminalScope(TERMINAL);
    await scope.scopeOfTerminalInput(b.ctx, TERMINAL);
    expect(runnerB.requests).toHaveLength(3);
  });
});

describe('auditIn', () => {
  it('records the actor, its space and the server (resource or ctx)', async () => {
    await scope.auditIn(b.ctx, { action: 'project.test', summary: 'essai', targetType: 'project', targetId: resB.projectId });
    await scope.auditIn(b.ctx, { action: 'project.other', summary: 'essai', environmentId: null });
    const rows = await db.select().from(auditLog).orderBy(desc(auditLog.id));
    expect(rows[1]).toMatchObject({
      action: 'project.test',
      actorUserId: b.user.id,
      actorKind: 'user',
      actorLabel: b.user.email,
      spaceId: b.space.id,
      environmentId: b.environment!.id,
    });
    expect(rows[0]).toMatchObject({ action: 'project.other', spaceId: b.space.id, environmentId: null });
  });
});
