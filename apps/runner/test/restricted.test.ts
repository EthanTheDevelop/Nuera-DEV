import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { appSettings, commandRuns, createDb, environments, operations, projects, sessions, uptimeDaily, user, worktrees, type Database } from '@nuera/db';
import { createRunnerLoginRole, dropRole, pgFailure } from '@nuera/db/test';
import type { OperationSnapshot, RunDto, SessionDto, SessionEventItem, WorktreeDto } from '@nuera/shared/runner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBareRemote,
  dbReady,
  dbUrl,
  defaultServer,
  git,
  seedProject,
  seedServer,
  startTestRunner,
  tmpDir,
  waitFor,
  type TestEnv,
  type TestServer,
} from './helpers';

type SqlClient = Parameters<typeof createRunnerLoginRole>[0];
const clientOf = (db: Database) => (db as unknown as { $client: SqlClient & { end: (o?: { timeout?: number }) => Promise<void> } }).$client;

/**
 * A server registered by the administration connects with its own login role IN ROLE nuera_runner
 * (docs/MULTICOMPTE.md §11, migration 0004): the core flows of the runner must work with the
 * GRANTs and row-level security policies of that role alone. A missing grant fails here, never
 * only in production.
 */
describe.skipIf(!dbReady)('restricted database role of a server (grants and RLS of 0004)', () => {
  const database = new URL(dbUrl).pathname.slice(1);
  const role = `${database}_restreint`.slice(0, 63);
  const password = randomBytes(16).toString('hex');
  const TOKEN_R = `test-runner-token-restreint-${Date.now().toString(36)}`;
  let admin: Database;
  let restrictedDb: Database;
  let r: TestEnv;
  let serverR: TestServer;
  let foreignProjectId: string;
  let projectId: string;
  let claudeConfig: string;

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    r.runner.api.inject({
      method,
      url,
      headers: { ...r.auth, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  const waitOperation = (id: string) =>
    waitFor(
      async () => {
        const op = (await call('GET', `/v1/operations/${id}`)).json() as OperationSnapshot;
        return op.status === 'succeeded' || op.status === 'failed' ? op : null;
      },
      { timeoutMs: 180_000, intervalMs: 300, label: `opération ${id}` },
    );

  beforeAll(async () => {
    admin = createDb(dbUrl, { max: 2, applicationName: 'nuera-runner-test-admin' });
    await createRunnerLoginRole(clientOf(admin), role, password);
    serverR = await seedServer(admin, { token: TOKEN_R, name: 'Serveur restreint', dbRole: role });
    // A project of another server (the default one): invisible to the restricted role.
    foreignProjectId = (await seedProject(admin, { fullName: 'nuera-studio/voisin', path: '/srv/ailleurs/voisin', slug: `voisin-${Date.now().toString(36)}`, server: await defaultServer(admin) })).id;

    const url = new URL(dbUrl);
    url.username = role;
    url.password = password;
    restrictedDb = createDb(url.toString(), { max: 5, applicationName: 'nuera-runner-test-restreint' });
    claudeConfig = tmpDir('claude-restreint');
    mkdirSync(path.join(claudeConfig, 'projects'), { recursive: true });
    r = await startTestRunner({ token: TOKEN_R, databaseUrl: url.toString(), claudeConfigDir: claudeConfig }, { db: restrictedDb });
  }, 600_000);

  afterAll(async () => {
    await r?.close().catch(() => undefined);
    if (admin) {
      await admin.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where usename = ${role}`).catch(() => undefined);
      await dropRole(clientOf(admin), role).catch(() => undefined);
      await clientOf(admin).end({ timeout: 5 }).catch(() => undefined);
    }
  }, 300_000);

  it('finds its server through row-level security and reports a restricted role', async () => {
    const health = (await call('GET', '/v1/health')).json() as { state: string; environment: { id: string } | null; database: { ok: boolean } };
    expect(health).toMatchObject({ state: 'ready', environment: { id: serverR.environmentId }, database: { ok: true } });
    await r.runner.services.heartbeat();
    const [row] = await admin.select().from(environments).where(eq(environments.id, serverR.environmentId));
    expect(row).toMatchObject({ status: 'active', backend: 'pty', capabilities: { database: { role, restricted: true } } });
  });

  it('holds its lease through nuera_runner_try_lease() and may take no other advisory lock (0005)', async () => {
    const tryAsOwner = async (key: string) => {
      const reserved = await clientOf(admin).reserve();
      try {
        const [row] = await reserved<Array<{ locked: boolean }>>`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as locked`;
        if (row?.locked) await reserved`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
        return row?.locked;
      } finally {
        reserved.release();
      }
    };
    // The lease of this server is held (same key as a runner using the full DSN), by the runner's own connection.
    expect(await tryAsOwner(`nuera:environment:${serverR.environmentId}`)).toBe(false);
    const [second] = await restrictedDb.execute<{ locked: boolean }>(sql`select public.nuera_runner_try_lease() as locked`);
    expect(second).toEqual({ locked: false });
    // Neither the migration lock (deploys), another server's lease nor the web's (integer, integer) locks.
    const other = await defaultServer(admin);
    for (const statement of [
      sql`select pg_advisory_lock(hashtextextended('nuera:migrate', 0))`,
      sql`select pg_try_advisory_lock(hashtextextended(${`nuera:environment:${other.environmentId}`}, 0))`,
      sql`select pg_try_advisory_lock(1, 2)`,
      sql`select pg_advisory_xact_lock(hashtextextended('nuera:migrate', 0))`,
      sql`select pg_try_advisory_lock_shared(hashtextextended('nuera:migrate', 0))`,
    ]) {
      expect(await pgFailure(restrictedDb.execute(statement))).toMatch(/permission denied/);
    }
    expect(await tryAsOwner('nuera:migrate')).toBe(true);
  });

  it('sees no other server, no account table and no token ciphertext', async () => {
    const visible = await restrictedDb.select({ id: projects.id }).from(projects);
    expect(visible.map((p) => p.id)).not.toContain(foreignProjectId);
    const servers = await restrictedDb.select({ id: environments.id }).from(environments);
    expect(servers.map((s) => s.id)).toEqual([serverR.environmentId]);
    expect(await pgFailure(restrictedDb.select({ id: user.id }).from(user))).toMatch(/permission denied/);
    expect(await pgFailure(restrictedDb.select({ t: environments.tokenEncrypted }).from(environments))).toMatch(/permission denied/);
    expect(await pgFailure(restrictedDb.update(environments).set({ status: 'active' }).where(eq(environments.id, serverR.environmentId)))).toMatch(/permission denied/);
    expect(await pgFailure(restrictedDb.select({ v: appSettings.webSessionIdleHours }).from(appSettings))).toMatch(/permission denied/);
    // Through the API: another server's project is unknown.
    const res = await call('POST', '/v1/sessions', { projectId: foreignProjectId, worktree: { mode: 'primary' } });
    expect(res.statusCode).toBe(404);
  });

  it('clones, synchronises, opens and removes a worktree, commits and runs a command', async () => {
    const remote = createBareRemote(r.dirs.remotes, 'nuera-studio/restreint');
    const project = await seedProject(admin, {
      fullName: 'nuera-studio/restreint',
      path: path.join(r.dirs.projects, 'restreint'),
      status: 'cloning',
      slug: 'restreint',
      server: serverR,
    });
    projectId = project.id;
    expect(remote.bare).toBeTruthy();
    const started = await call('POST', '/v1/repos/clone', { projectId, fullName: 'nuera-studio/restreint', destination: 'restreint', installDeps: false, actorUserId: serverR.userId });
    expect(started.statusCode).toBe(200);
    const clone = await waitOperation((started.json() as { operationId: string }).operationId);
    expect(clone.status).toBe('succeeded');
    const [ready] = await admin.select().from(projects).where(eq(projects.id, projectId));
    expect(ready).toMatchObject({ status: 'ready', currentBranch: 'main' });

    expect((await call('GET', `/v1/repos/${projectId}/sync`)).statusCode).toBe(200);
    expect((await call('POST', `/v1/repos/${projectId}/fetch`, {})).statusCode).toBe(200);
    const list = (await call('GET', `/v1/repos/${projectId}/worktrees`)).json() as { worktrees: WorktreeDto[] };
    const primary = list.worktrees.find((w) => w.isPrimary)!;

    const created = await call('POST', `/v1/repos/${projectId}/worktrees`, { branch: 'feature/restreinte', actorUserId: serverR.userId });
    expect(created.statusCode).toBe(200);
    const worktree = created.json() as WorktreeDto;
    const [wtRow] = await admin.select().from(worktrees).where(eq(worktrees.id, worktree.id));
    expect(wtRow!.environmentId).toBe(serverR.environmentId);

    writeFileSync(path.join(primary.path, 'NOTES.md'), 'Note du serveur restreint\n');
    const commit = await call('POST', `/v1/worktrees/${primary.id}/commit`, {
      message: 'docs: note',
      author: { name: 'Camille Martin', email: 'camille@example.test' },
      paths: ['NOTES.md'],
      actorUserId: serverR.userId,
    });
    expect(commit.statusCode).toBe(200);
    const [afterCommit] = await admin.select().from(projects).where(eq(projects.id, projectId));
    expect(afterCommit!.lastCommitMessage).toBe('docs: note');
    expect(git(primary.path, 'log', '-1', '--format=%an <%ae>')).toBe('Camille Martin <camille@example.test>');

    const run = (await call('POST', '/v1/runs', { projectId, kind: 'custom', command: 'node -e "console.log(42)"', actorUserId: serverR.userId })).json() as RunDto;
    const done = await waitFor(async () => {
      const current = (await call('GET', `/v1/runs/${run.id}`)).json() as RunDto;
      return current.status !== 'running' ? current : null;
    }, { timeoutMs: 120_000, intervalMs: 300, label: 'fin de la commande' });
    expect(done.status).toBe('succeeded');
    const [runRow] = await admin.select().from(commandRuns).where(eq(commandRuns.id, run.id));
    expect(runRow).toMatchObject({ environmentId: serverR.environmentId, actorUserId: serverR.userId });

    const removed = await call('DELETE', `/v1/worktrees/${worktree.id}?actorUserId=${serverR.userId}`);
    expect(removed.statusCode).toBe(200);
    const [removeOp] = await admin.select().from(operations).where(eq(operations.id, (removed.json() as { operationId: string }).operationId));
    expect(removeOp).toMatchObject({ kind: 'worktree_remove', status: 'succeeded', actorUserId: serverR.userId, environmentId: serverR.environmentId });
  }, 600_000);

  it('runs a Claude session with its events, a permission decided in Nuera and the bypass policy', async () => {
    const createdRes = await call('POST', '/v1/sessions', {
      projectId,
      title: 'Session restreinte',
      worktree: { mode: 'new', branch: 'feature/session-restreinte' },
      launch: { permissionWaitSeconds: 120, gitIdentity: { name: 'Camille Martin', email: 'camille@example.test' } },
      createdByUserId: serverR.userId,
    });
    expect(createdRes.statusCode).toBe(200);
    const id = (createdRes.json() as SessionDto).id;
    expect((await call('POST', `/v1/sessions/${id}/instruction`, { text: 'scenario:full Termine le module.' })).statusCode).toBe(200);
    const waiting = await waitFor(async () => {
      const s = (await call('GET', `/v1/sessions/${id}`)).json() as SessionDto;
      return s.pendingPermission ? s : null;
    }, { timeoutMs: 420_000, intervalMs: 500, label: "demande d'autorisation" });
    const decision = await call('POST', `/v1/permissions/${waiting.pendingPermission!.id}/decision`, { behavior: 'allow', decidedByUserId: serverR.userId });
    expect(decision.statusCode).toBe(200);
    await waitFor(async () => {
      const s = (await call('GET', `/v1/sessions/${id}`)).json() as SessionDto;
      return s.status === 'waiting_input' && s.lastInstruction ? s : null;
    }, { timeoutMs: 420_000, intervalMs: 500, label: 'fin du tour' });
    const items = ((await call('GET', `/v1/sessions/${id}/events?limit=500`)).json() as { items: SessionEventItem[] }).items;
    expect(items.some((i) => i.kind === 'tool')).toBe(true);
    expect(items.find((i) => i.kind === 'permission')?.payload).toMatchObject({ status: 'allowed' });
    expect((await call('POST', `/v1/sessions/${id}/stop`, { force: true })).statusCode).toBe(200);

    // The bypass policy comes with the launch options; the instance-wide block is still read.
    const bypass = (blockBypassPermissions: boolean) =>
      call('POST', '/v1/sessions', { projectId, title: 'Sans autorisation', permissionMode: 'bypassPermissions', worktree: { mode: 'primary' }, launch: { blockBypassPermissions } });
    expect((await bypass(true)).statusCode).toBe(403);
    expect((await bypass(false)).statusCode).toBe(200);
    await admin.update(appSettings).set({ forceBlockBypassPermissions: true }).where(eq(appSettings.id, 1));
    try {
      const forced = await bypass(false);
      expect(forced.statusCode).toBe(403);
      expect((forced.json() as { error: { reason: string } }).error.reason).toBe('BYPASS_BLOCKED');
    } finally {
      await admin.update(appSettings).set({ forceBlockBypassPermissions: false }).where(eq(appSettings.id, 1));
    }
  }, 1_200_000);

  it('records a usage-limit stop and its automatic resumption (sessions.usage_limit, 0006)', async () => {
    const created = await call('POST', '/v1/sessions', {
      projectId,
      title: 'Limite restreinte',
      worktree: { mode: 'new', branch: 'feature/limite-restreinte' },
      launch: { autoResume: { enabled: true } },
    });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as SessionDto).id;
    expect((await call('POST', `/v1/sessions/${id}/instruction`, { text: 'scenario:limit:900' })).statusCode).toBe(200);
    const limited = await waitFor(async () => {
      const s = (await call('GET', `/v1/sessions/${id}`)).json() as SessionDto;
      return s.limit?.active && s.limit.autoResume?.outcome === 'scheduled' ? s : null;
    }, { timeoutMs: 120_000, intervalMs: 300, label: 'limite enregistrée' });
    expect(limited.errorCode).toBe('rate_limit');
    const off = await call('POST', `/v1/sessions/${id}/auto-resume`, { enabled: false });
    expect(off.statusCode).toBe(200);
    expect((off.json() as SessionDto).limit?.autoResume).toMatchObject({ enabled: false, outcome: 'off' });
    expect((await call('POST', `/v1/sessions/${id}/stop`, { force: true })).statusCode).toBe(200);
    expect((await admin.select({ usageLimit: sessions.usageLimit }).from(sessions).where(eq(sessions.id, id)))[0]!.usageLimit).toBeNull();
  }, 300_000);

  it('refuses a session id already taken (on its server or another one) before creating any worktree', async () => {
    const [foreign] = await admin
      .insert(sessions)
      .values({ id: randomUUID(), projectId: foreignProjectId, environmentId: (await defaultServer(admin)).environmentId, title: 'Ailleurs', status: 'new', backend: 'pty' })
      .returning();
    const [own] = await admin
      .insert(sessions)
      .values({ id: randomUUID(), projectId, environmentId: serverR.environmentId, title: 'Ici', status: 'new', backend: 'pty' })
      .returning();
    // Invisible to the restricted role, yet its id is unique across servers.
    expect(await restrictedDb.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, foreign!.id))).toEqual([]);
    const worktreeCount = async () => (await admin.select({ id: worktrees.id }).from(worktrees).where(eq(worktrees.projectId, projectId))).length;
    const before = await worktreeCount();
    for (const [i, taken] of [foreign!.id, own!.id].entries()) {
      const res = await call('POST', '/v1/sessions', { sessionId: taken, projectId, title: 'Identifiant pris', worktree: { mode: 'new', branch: `feature/id-pris-${i}` } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: { code: 'CONFLICT', message: 'Une session porte déjà cet identifiant.' } });
    }
    expect(await worktreeCount()).toBe(before);
    const primary = ((await call('GET', `/v1/repos/${projectId}/worktrees`)).json() as { worktrees: WorktreeDto[] }).worktrees.find((w) => w.isPrimary)!;
    expect(git(primary.path, 'branch', '--list', 'feature/id-pris-*')).toBe('');
    // The other server's row is untouched.
    expect((await admin.select({ title: sessions.title }).from(sessions).where(eq(sessions.id, foreign!.id)))[0]!.title).toBe('Ailleurs');

    // A free id is used as given (the probe left nothing behind).
    const freeId = randomUUID();
    const created = await call('POST', '/v1/sessions', { sessionId: freeId, projectId, title: 'Identifiant libre', worktree: { mode: 'primary' } });
    expect(created.statusCode).toBe(200);
    expect((created.json() as SessionDto).id).toBe(freeId);
    expect(await admin.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, freeId))).toHaveLength(1);
  }, 300_000);

  it('reconciles its own rows and records its availability after a restart', async () => {
    const [session] = await admin
      .insert(sessions)
      .values({ id: randomUUID(), projectId, environmentId: serverR.environmentId, title: 'Vivante', status: 'running', backend: 'pty', startedAt: new Date() })
      .returning();
    const [operation] = await admin
      .insert(operations)
      .values({ environmentId: serverR.environmentId, projectId, kind: 'fetch', status: 'running', startedAt: new Date() })
      .returning();
    const [run] = await admin
      .insert(commandRuns)
      .values({ environmentId: serverR.environmentId, projectId, kind: 'custom', command: 'node serveur.js', status: 'running' })
      .returning();
    await r.runner.services.uptime.beat();
    const dirs = r.dirs;
    await r.close({ keepFolders: true });
    const url = new URL(dbUrl);
    url.username = role;
    url.password = password;
    restrictedDb = createDb(url.toString(), { max: 5, applicationName: 'nuera-runner-test-restreint' });
    r = await startTestRunner({ token: TOKEN_R, databaseUrl: url.toString(), claudeConfigDir: claudeConfig }, { db: restrictedDb, dirs });

    expect((await admin.select({ s: sessions.status }).from(sessions).where(eq(sessions.id, session!.id)))[0]!.s).toBe('interrupted');
    expect((await admin.select({ s: operations.status }).from(operations).where(eq(operations.id, operation!.id)))[0]!.s).toBe('failed');
    expect((await admin.select({ s: commandRuns.status }).from(commandRuns).where(eq(commandRuns.id, run!.id)))[0]!.s).toBe('stopped');

    await r.runner.services.uptime.beat();
    const rows = await admin.select().from(uptimeDaily).where(eq(uptimeDaily.service, `runner:${serverR.environmentId}`));
    expect(rows.length).toBeGreaterThan(0);
    expect(((await call('GET', '/v1/system/uptime?days=7')).json() as { service: string }).service).toBe(`runner:${serverR.environmentId}`);
  }, 600_000);
});
