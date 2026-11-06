import { createCipheriv, randomBytes } from 'node:crypto';
import { auditLog, commandRuns, githubSources, operations, projectEnvVars, projects, sessions, worktrees } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@/server/tenancy/context';
import { createTestAccount, type TestAccount } from '@/server/tenancy/test/fixtures';
import { TEST_ENVIRONMENT_ID, TEST_SPACE_ID, TEST_USER_ID, closeProjectsDb, prepareProjectsDatabase, resetProjectTables, testContext, useTestEncryptionKey } from './test/db';

/*
 * Projets server module against a real database (nuera_projects_core), with runner and GitHub
 * doubles: list (filters, counters of the space, favourites first, sync/conflict, sessions),
 * creation (A4 refusal writes nothing, clone with a READ token of the bound source on the space's
 * server, runner failure removes the row, uniqueness per server), sync T4 copy, runs (decrypted
 * variables, actor and Git identity), env vars (secrets never returned, encrypted bound to their
 * row), archive / restore — all through the request context of the space.
 */

const state = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: unknown; environmentId: string }>,
  destination: { available: true, exists: false, empty: true, fileCount: 0, suggestedPath: null as string | null },
  cloneFailure: null as null | { code: string; message: string; reason?: string },
  pullFailure: null as null | { code: string; message: string; reason?: string; data?: Record<string, unknown> },
  /** Runner reads of the project page: 'down' (unreachable) or 'timeout' (no answer in time). */
  reads: 'down' as 'down' | 'timeout',
  /** Answer of runner.listWorktrees when set (otherwise it fails like the other reads). */
  worktreeList: null as null | Array<Record<string, unknown>>,
  /** Answer (or refusal) of runner.removeClone. */
  cloneRemoval: null as null | { code: string; message: string; reason: string },
  /** Source bound by resolveSourceForRepo (null = fallback token). */
  boundSource: null as null | string,
  github: [] as Array<{ name: string; input: unknown }>,
}));

vi.mock('@/server/runner/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/runner/client')>();
  const sync = { projectId: '00000000-0000-4000-8000-000000000000', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, state: 'up_to_date', lastFetchedAt: null, headSha: null, headMessage: null, headDate: null, dirtyFiles: 0 };
  const fake: Record<string, (input: never) => Promise<unknown>> = {
    systemMetrics: async () => {
      throw new original.RunnerError('RUNNER_UNAVAILABLE', 'VPS-3 ne répond pas.');
    },
    checkDestination: async (input: { body: { path: string } }) => {
      const path = input.body.path.startsWith('/') ? input.body.path : `/srv/dev/${input.body.path}`;
      return { path, existingClone: null, ...state.destination };
    },
    cloneRepo: async () => {
      if (state.cloneFailure) {
        const f = state.cloneFailure;
        throw new original.RunnerError(f.code as never, f.message, f.reason ? { reason: f.reason } : {});
      }
      const operation = { id: '11111111-1111-4111-8111-111111111111' };
      return { operationId: operation.id, operation };
    },
    pullRepo: async () => {
      if (state.pullFailure) {
        const f = state.pullFailure;
        throw new original.RunnerError(f.code as never, f.message, { ...(f.reason ? { reason: f.reason } : {}), ...(f.data ? { data: f.data } : {}), untouched: "Aucun commit ni fichier local n'a été modifié." });
      }
      return { operationId: null, outcome: 'fast_forward', before: 'a', after: 'b', commits: 2, sync };
    },
    fetchRepo: async () => ({ operationId: null, sync }),
    ...Object.fromEntries(
      ['listBranches', 'listWorktrees', 'repoStatus', 'readClaudeMd', 'listSessions'].map((name) => [
        name,
        async () => {
          if (name === 'listWorktrees' && state.worktreeList) return { worktrees: state.worktreeList };
          if (state.reads === 'timeout') {
            const cause = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
            throw new original.RunnerError('UPSTREAM', "Le runner n'a pas répondu à temps.", { cause });
          }
          throw new original.RunnerError('RUNNER_UNAVAILABLE', 'VPS-3 ne répond pas.');
        },
      ]),
    ),
    writeClaudeMd: async () => ({ worktreeId: '33333333-3333-4333-8333-333333333333', lines: 12, commitSha: 'c0ffee1234567890' }),
    removeClone: async () => {
      if (state.cloneRemoval) {
        const f = state.cloneRemoval;
        throw new original.RunnerError(f.code as never, f.message, { reason: f.reason, untouched: "Rien n'a été supprimé du disque." });
      }
      return { operationId: '44444444-4444-4444-8444-444444444444', removed: true, freedBytes: 2_254_857_830, worktrees: 1 };
    },
    removeWorktree: async () => ({ removed: true, branchDeleted: false }),
    createRun: async (input: { body: Record<string, unknown> }) => ({ id: '22222222-2222-4222-8222-222222222222', projectId: input.body.projectId, worktreeId: input.body.worktreeId, kind: input.body.kind, command: input.body.command, status: 'running', exitCode: null, pid: 1, port: null, summary: null, tests: null, startedAt: new Date().toISOString(), finishedAt: null, live: true }),
  };
  /** One recording client per server: every call notes the server it went to. */
  const getRunnerForEnvironment = (environmentId: string) =>
    new Proxy(
      {},
      {
        get: (_target, name: string) => async (input: unknown) => {
          state.calls.push({ name, input, environmentId });
          const method = fake[name];
          if (!method) throw new original.RunnerError('RUNNER_UNAVAILABLE', 'VPS-3 ne répond pas.');
          return method(input as never);
        },
      },
    );
  return { ...original, getRunnerForEnvironment };
});

vi.mock('@/server/github', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/github')>();
  const header = 'AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dGVzdA==';
  const record = (name: string, input: unknown) => state.github.push({ name, input });
  return {
    ...original,
    getRepo: async (ref: { fullName?: string; githubFullName?: string }) => {
      const fullName = ref.fullName ?? ref.githubFullName ?? '';
      record('getRepo', ref);
      return {
        id: 42,
        fullName,
        name: fullName.split('/')[1],
        owner: fullName.split('/')[0],
        private: true,
        description: null,
        language: 'TypeScript',
        defaultBranch: 'main',
        htmlUrl: `https://github.com/${fullName}`,
        cloneUrl: `https://github.com/${fullName}.git`,
        pushedAt: null,
        archived: false,
      };
    },
    resolveSourceForRepo: async (ref: unknown) => {
      record('resolveSourceForRepo', ref);
      return { mode: 'app', sourceId: state.boundSource, sourceLabel: state.boundSource ? 'nuera-studio' : null, installationId: state.boundSource ? 7 : null };
    },
    getGitAuthForRepo: async (ref: unknown, access: string) => {
      record('getGitAuthForRepo', { ref, access });
      return { extraHeader: header, expiresAt: new Date(Date.now() + 3600_000).toISOString(), sourceId: state.boundSource };
    },
    getGitAuthForProject: async (project: { id: string; githubSourceId: string | null }, access: string) => {
      record('getGitAuthForProject', { projectId: project.id, sourceId: project.githubSourceId, access });
      return { extraHeader: header, expiresAt: new Date(Date.now() + 3600_000).toISOString(), sourceId: project.githubSourceId };
    },
    listProtectedBranches: async () => ['main'],
  };
});

// The project page reads its sessions through the Sessions lot; its database fallback is tested here.
vi.mock('@/server/sessions', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/sessions')>();
  return {
    ...original,
    listSessions: async () => {
      throw new Error('listSessions indisponible dans ce test');
    },
  };
});

const { db } = await import('@/server/db');
const mod = await import('./index');

let ctx: RequestContext;

async function insertProject(values: Partial<typeof projects.$inferInsert> & { slug: string }, owner: Pick<RequestContext, 'space' | 'environment'> = ctx) {
  const [row] = await db
    .insert(projects)
    .values({
      spaceId: owner.space.id,
      environmentId: owner.environment!.id,
      name: values.slug,
      githubFullName: `atelier/${values.slug}`,
      cloneUrl: `https://github.com/atelier/${values.slug}.git`,
      path: `/srv/dev/${values.slug}`,
      status: 'ready',
      ...values,
    })
    .returning();
  const [wt] = await db
    .insert(worktrees)
    .values({ projectId: row!.id, environmentId: row!.environmentId, name: values.slug, branch: 'main', path: row!.path, isPrimary: true })
    .returning();
  return { project: row!, worktree: wt! };
}

function sessionOf(projectId: string, values: Partial<typeof sessions.$inferInsert> & { title: string }) {
  return { id: crypto.randomUUID(), projectId, environmentId: TEST_ENVIRONMENT_ID, status: 'running' as const, ...values };
}

beforeAll(async () => {
  useTestEncryptionKey();
  await prepareProjectsDatabase('core');
});
afterAll(async () => closeProjectsDb());
beforeEach(async () => {
  state.calls = [];
  state.github = [];
  state.destination = { available: true, exists: false, empty: true, fileCount: 0, suggestedPath: null };
  state.cloneFailure = null;
  state.pullFailure = null;
  state.reads = 'down';
  state.worktreeList = null;
  state.cloneRemoval = null;
  state.boundSource = null;
  await resetProjectTables();
  ctx = testContext();
});

describe('listProjects', () => {
  it('filters, counts, puts favourites first and summarises sessions', async () => {
    const a = await insertProject({ slug: 'alpha', name: 'Alpha', lastOpenedAt: new Date(Date.now() - 60_000) });
    const b = await insertProject({ slug: 'beta', name: 'Beta', isFavorite: true, lastOpenedAt: new Date(Date.now() - 3600_000) });
    await insertProject({ slug: 'gamma', name: 'Gamma', archivedAt: new Date() });
    await db.insert(sessions).values([
      sessionOf(a.project.id, { title: 's1' }),
      sessionOf(a.project.id, { title: 's2' }),
      sessionOf(b.project.id, { title: 's3', status: 'interrupted' }),
    ]);
    await db.insert(operations).values({ kind: 'pull', status: 'failed', projectId: b.project.id, environmentId: TEST_ENVIRONMENT_ID, error: { code: 'CONFLICT', message: 'x', reason: 'PULL_CONFLICT' } as never });

    const all = await mod.listProjects(ctx);
    expect(all.counts).toEqual({ all: 2, favorites: 1, archived: 1 });
    expect(all.items.map((item) => item.name)).toEqual(['Beta', 'Alpha']);
    expect(all.items[1]!.sessions).toMatchObject({ active: 2, total: 2 });
    expect(all.items[0]!.sync.conflict).toBe(true);
    expect(all.runnerAvailable).toBe(false);
    expect(all.disk).toBeNull();
    expect(all.environment).toEqual({ id: TEST_ENVIRONMENT_ID, name: 'VPS-3' });
    expect(state.calls.map((c) => [c.name, c.environmentId])).toEqual([['systemMetrics', TEST_ENVIRONMENT_ID]]);

    expect((await mod.listProjects(ctx, { filter: 'favoris' })).items.map((i) => i.name)).toEqual(['Beta']);
    expect((await mod.listProjects(ctx, { filter: 'archives' })).items.map((i) => i.name)).toEqual(['Gamma']);
    expect((await mod.listProjects(ctx, { q: 'ALP' })).items.map((i) => i.name)).toEqual(['Alpha']);
    expect((await mod.listProjects(ctx, { q: '%' })).items).toHaveLength(0);
  });

  it('marks a running fetch as « Synchronisation… »', async () => {
    const a = await insertProject({ slug: 'alpha' });
    await db.insert(operations).values({ kind: 'fetch', status: 'running', projectId: a.project.id, environmentId: TEST_ENVIRONMENT_ID });
    const [item] = (await mod.listProjects(ctx)).items;
    expect(item!.sync.syncing).toBe(true);
    expect(item!.operation?.kind).toBe('fetch');
  });

  it("never lists nor counts another space's projects, and asks no runner without a server", async () => {
    await insertProject({ slug: 'alpha', isFavorite: true });
    const other = await createTestAccount({ role: 'member', name: 'Camille Martin', environment: { configSource: 'db', name: 'VPS-4' } });
    await insertProject({ slug: 'secret', isFavorite: true, path: '/srv/dev/secret' }, other.ctx);
    await insertProject({ slug: 'vieux', archivedAt: new Date(), path: '/srv/dev/vieux' }, other.ctx);
    const mine = await mod.listProjects(ctx, { includeArchived: true });
    expect(mine.items.map((i) => i.slug)).toEqual(['alpha']);
    expect(mine.counts).toEqual({ all: 1, favorites: 1, archived: 0 });
    const theirs = await mod.listProjects(other.ctx);
    expect(theirs.items.map((i) => i.slug)).toEqual(['secret']);
    expect(theirs.counts).toEqual({ all: 1, favorites: 1, archived: 1 });
    expect(theirs.environment).toEqual({ id: other.environment!.id, name: 'VPS-4' });

    const lonely = await createTestAccount({ role: 'member', name: 'Sans Serveur', environment: false });
    state.calls = [];
    const empty = await mod.listProjects(lonely.ctx);
    expect(empty).toMatchObject({ items: [], counts: { all: 0, favorites: 0, archived: 0 }, disk: null, runnerAvailable: false, environment: null });
    expect(state.calls).toHaveLength(0);
  });
});

describe('createProject', () => {
  const input = { fullName: 'atelier/roux-conseil', name: 'Roux Conseil', destination: 'roux-conseil', installDeps: true, worktreePerSession: true, readClaudeMd: true, commands: {} };

  it("inserts the row (cloning) in the space, on its server, and clones with a READ token of that repository", async () => {
    const result = await mod.createProject(ctx, input);
    const [row] = await db.select().from(projects).where(eq(projects.id, result.projectId));
    expect(row).toMatchObject({
      status: 'cloning',
      name: 'Roux Conseil',
      slug: 'roux-conseil',
      path: '/srv/dev/roux-conseil',
      githubFullName: 'atelier/roux-conseil',
      spaceId: TEST_SPACE_ID,
      environmentId: TEST_ENVIRONMENT_ID,
      createdByUserId: TEST_USER_ID,
      githubSourceId: null,
    });
    expect(state.github.find((c) => c.name === 'getGitAuthForRepo')?.input).toEqual({ ref: { spaceId: TEST_SPACE_ID, fullName: 'atelier/roux-conseil' }, access: 'read' });
    const clone = state.calls.find((c) => c.name === 'cloneRepo')!;
    expect(clone.environmentId).toBe(TEST_ENVIRONMENT_ID);
    expect((clone.input as { body: Record<string, unknown> }).body).toMatchObject({ projectId: result.projectId, destination: '/srv/dev/roux-conseil', installDeps: true, actorUserId: TEST_USER_ID });
    expect(String((clone.input as { body: Record<string, unknown> }).body.extraHeader)).toMatch(/^AUTHORIZATION: basic /);
    const logs = await db.select().from(auditLog).where(eq(auditLog.action, 'project.created'));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorUserId: TEST_USER_ID, spaceId: TEST_SPACE_ID, environmentId: TEST_ENVIRONMENT_ID, actorLabel: ctx.user.email });
    expect(JSON.stringify(logs)).not.toContain('eC1hY2Nlc3MtdG9rZW46dGVzdA');
  });

  it('binds the GitHub source chosen (or resolved) at creation', async () => {
    const [source] = await db.insert(githubSources).values({ spaceId: TEST_SPACE_ID, label: 'nuera-studio', status: 'connected' }).returning();
    state.boundSource = source!.id;
    const result = await mod.createProject(ctx, { ...input, sourceId: source!.id });
    const [row] = await db.select().from(projects).where(eq(projects.id, result.projectId));
    expect(row).toMatchObject({ githubSourceId: source!.id, githubInstallationId: 7 });
    expect(state.github.find((c) => c.name === 'resolveSourceForRepo')?.input).toEqual({ spaceId: TEST_SPACE_ID, fullName: 'atelier/roux-conseil', sourceId: source!.id });
  });

  it('A4: a non-empty destination writes nothing and carries the suggestion', async () => {
    state.destination = { available: false, exists: true, empty: false, fileCount: 14, suggestedPath: '/srv/dev/roux-conseil-landing' };
    const error = await mod.createProject(ctx, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(mod.ProjectError);
    const body = (await mod.projectErrorResponse(error).json()) as { error: { reason: string; data: Record<string, unknown>; untouched: string } };
    expect(body.error.reason).toBe('DESTINATION_NOT_EMPTY');
    expect(body.error.data).toMatchObject({ fileCount: 14, suggestedPath: '/srv/dev/roux-conseil-landing' });
    expect(body.error.untouched).toBe("Rien n'a été écrasé.");
    expect(await db.select().from(projects)).toHaveLength(0);
    expect(state.calls.some((c) => c.name === 'cloneRepo')).toBe(false);
  });

  it('removes the row again when the runner refuses the clone', async () => {
    state.cloneFailure = { code: 'CONFLICT', message: 'refus' };
    await expect(mod.createProject(ctx, input)).rejects.toThrow('refus');
    expect(await db.select().from(projects)).toHaveLength(0);
  });

  it('refuses a repository already tracked in the space, naming that project only', async () => {
    const { project } = await insertProject({ slug: 'roux', name: 'Roux', githubFullName: 'atelier/roux-conseil' });
    const error = await mod.createProject(ctx, input).catch((e: unknown) => e);
    expect((error as InstanceType<typeof mod.ProjectError>).reason).toBe('ALREADY_TRACKED');
    expect((error as Error).message).toBe('atelier/roux-conseil est déjà cloné dans votre espace (« Roux »).');
    const body = (await mod.projectErrorResponse(error).json()) as { error: { data: { existingProject: { id: string } } } };
    expect(body.error.data.existingProject.id).toBe(project.id);
  });

  it('gives a unique slug when the name is taken on the server', async () => {
    await insertProject({ slug: 'roux-conseil', githubFullName: 'autre/roux-conseil', path: '/srv/dev/ailleurs' });
    const result = await mod.createProject(ctx, { ...input, destination: '/srv/dev/second' });
    const [row] = await db.select().from(projects).where(eq(projects.id, result.projectId));
    expect(row!.slug).toBe('roux-conseil-2');
  });

  it("is never blocked nor informed by another space's project of the same repository, slug or folder", async () => {
    const other = await createTestAccount({ role: 'member', name: 'Camille Martin', environment: { configSource: 'db', name: 'VPS-4' } });
    await insertProject({ slug: 'roux-conseil', name: 'Projet secret', githubFullName: 'atelier/roux-conseil', path: '/srv/dev/roux-conseil' }, other.ctx);
    state.destination = { available: true, exists: true, empty: true, fileCount: 0, suggestedPath: null };
    const check = await mod.checkProjectDestination(ctx, { path: '/srv/dev/roux-conseil' });
    expect(check.existingProject).toBeNull();
    const result = await mod.createProject(ctx, input);
    const [row] = await db.select().from(projects).where(eq(projects.id, result.projectId));
    // Same slug and path as the other space's project: unique per server only.
    expect(row).toMatchObject({ slug: 'roux-conseil', path: '/srv/dev/roux-conseil', spaceId: TEST_SPACE_ID });
  });

  it('answers NO_ENVIRONMENT without a server, before any GitHub or runner call', async () => {
    const lonely = await createTestAccount({ role: 'member', name: 'Sans Serveur', environment: false });
    const error = (await mod.createProject(lonely.ctx, input).catch((e: unknown) => e)) as { code: string; reason: string };
    expect(error).toMatchObject({ code: 'CONFLICT', reason: 'NO_ENVIRONMENT' });
    const body = (await mod.projectErrorResponse(error).json()) as { error: { reason: string; message: string } };
    expect(body.error).toMatchObject({ reason: 'NO_ENVIRONMENT', message: 'Aucun serveur ne vous est encore attribué : un administrateur doit vous en attribuer un.' });
    await expect(mod.checkProjectDestination(lonely.ctx, { path: 'x' })).rejects.toMatchObject({ reason: 'NO_ENVIRONMENT' });
    expect(state.calls).toHaveLength(0);
    expect(state.github).toHaveLength(0);
    expect(await db.select().from(projects)).toHaveLength(0);
  });
});

describe('syncProject', () => {
  it('fast-forwards with a read token of the project source and audits', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    const result = await mod.syncProject(ctx, project.id);
    expect(result).toMatchObject({ outcome: 'fast_forward', commits: 2 });
    expect(state.github.find((c) => c.name === 'getGitAuthForProject')?.input).toEqual({ projectId: project.id, sourceId: null, access: 'read' });
    expect(state.calls.find((c) => c.name === 'pullRepo')).toMatchObject({ environmentId: TEST_ENVIRONMENT_ID, input: { body: { actorUserId: TEST_USER_ID } } });
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'project.synced'))).length).toBe(1);
  });

  it('maps PULL_DIVERGED to the T4 copy and keeps the reason', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    state.pullFailure = { code: 'CONFLICT', message: 'main et origin/main ont divergé', reason: 'PULL_DIVERGED', data: { ahead: 1, behind: 2, remoteUrl: 'https://x:secret@github.com' } };
    const error = await mod.syncProject(ctx, project.id).catch((e: unknown) => e);
    const body = (await mod.projectErrorResponse(error).json()) as { error: { message: string; reason: string; detail: string; data: Record<string, unknown> } };
    expect(body.error).toMatchObject({ message: 'La branche locale et origin ont divergé', reason: 'PULL_DIVERGED', detail: 'main et origin/main ont divergé' });
    expect(body.error.data).toEqual({ ahead: 1, behind: 2 });
  });

  it('falls back to a fetch when the branch has no upstream', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    state.pullFailure = { code: 'CONFLICT', message: 'pas sur origin', reason: 'NO_UPSTREAM' };
    const result = await mod.syncProject(ctx, project.id);
    expect(result.outcome).toBe('fetched');
    expect(state.calls.some((c) => c.name === 'fetchRepo')).toBe(true);
  });

  it('refuses an archived project', async () => {
    const { project } = await insertProject({ slug: 'alpha', archivedAt: new Date() });
    await expect(mod.syncProject(ctx, project.id)).rejects.toThrow(/archivé/);
  });
});

describe('environment variables', () => {
  it('never returns a secret value and stores everything encrypted', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    const secret = await mod.createEnvVar(ctx, project.id, { key: 'DATABASE_URL', value: 'postgres://u:tres-secret@db/x', secret: true });
    const plain = await mod.createEnvVar(ctx, project.id, { key: 'NEXT_PUBLIC_SITE_URL', value: 'https://os.example', secret: false });
    expect(secret.value).toBeNull();
    expect(plain.value).toBe('https://os.example');
    const listed = await mod.listEnvVars(ctx, project.id);
    expect(listed.map((v) => [v.key, v.value])).toEqual([
      ['DATABASE_URL', null],
      ['NEXT_PUBLIC_SITE_URL', 'https://os.example'],
    ]);
    const stored = JSON.stringify(await db.select().from(projectEnvVars));
    expect(stored).not.toContain('tres-secret');
    expect(stored).not.toContain('os.example');
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain('tres-secret');
  });

  it('binds each value to its row: a ciphertext moved to another project is unreadable', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    const other = await insertProject({ slug: 'beta' });
    await mod.createEnvVar(ctx, project.id, { key: 'API_URL', value: 'https://alpha.example', secret: false });
    const [row] = await db.select().from(projectEnvVars).where(eq(projectEnvVars.projectId, project.id));
    expect(row!.valueEncrypted.startsWith('b1.')).toBe(true);
    await db.insert(projectEnvVars).values({ projectId: other.project.id, key: 'API_URL', valueEncrypted: row!.valueEncrypted, isSecret: false });
    expect((await mod.listEnvVars(ctx, other.project.id)).map((v) => v.value)).toEqual([null]);
  });

  it('still reads a legacy value and rewrites it bound on its next update', async () => {
    const { project } = await insertProject({ slug: 'alpha', commands: { test: 'npm test' } });
    const legacy = legacyCipher('valeur-historique');
    const [row] = await db.insert(projectEnvVars).values({ projectId: project.id, key: 'OLD_VALUE', valueEncrypted: legacy, isSecret: false }).returning();
    expect((await mod.listEnvVars(ctx, project.id))[0]?.value).toBe('valeur-historique');
    await mod.startRun(ctx, { projectId: project.id, kind: 'test' });
    expect((state.calls.find((c) => c.name === 'createRun')!.input as { body: { env: Record<string, string> } }).body.env).toEqual({ OLD_VALUE: 'valeur-historique' });
    await mod.updateEnvVar(ctx, project.id, { id: row!.id, secret: true });
    const [rewritten] = await db.select().from(projectEnvVars).where(eq(projectEnvVars.id, row!.id));
    expect(rewritten!.valueEncrypted.startsWith('b1.')).toBe(true);
    expect(rewritten!.isSecret).toBe(true);
    await mod.updateEnvVar(ctx, project.id, { id: row!.id, secret: false, value: 'nouvelle' });
    expect((await mod.listEnvVars(ctx, project.id))[0]?.value).toBe('nouvelle');
  });

  it('requires a new value to make a secret visible, refuses protected names and duplicates', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    const v = await mod.createEnvVar(ctx, project.id, { key: 'API_KEY', value: 'k1', secret: true });
    await expect(mod.updateEnvVar(ctx, project.id, { id: v.id, secret: false })).rejects.toThrow(/nouvelle valeur/);
    const shown = await mod.updateEnvVar(ctx, project.id, { id: v.id, secret: false, value: 'public' });
    expect(shown.value).toBe('public');
    await expect(mod.createEnvVar(ctx, project.id, { key: 'API_KEY', value: 'x', secret: true })).rejects.toThrow(/existe déjà/);
    await expect(mod.createEnvVar(ctx, project.id, { key: 'ANTHROPIC_API_KEY', value: 'x', secret: true })).rejects.toThrow();
    await expect(mod.createEnvVar(ctx, project.id, { key: 'NUERA_X', value: 'x', secret: true })).rejects.toThrow();
    expect(await mod.deleteEnvVar(ctx, project.id, v.id)).toEqual({ deleted: true });
    expect(await mod.listEnvVars(ctx, project.id)).toHaveLength(0);
  });
});

/** A value in the format written before the multi-account model (associated data = key id). */
function legacyCipher(plain: string): string {
  const key = Buffer.from(process.env.APP_ENCRYPTION_KEY!, 'base64');
  const keyId = process.env.APP_ENCRYPTION_KEY_ID ?? 'v1';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(keyId, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${keyId}:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

describe('runs', () => {
  it('starts the configured command in the primary clone with the decrypted variables, the actor and its Git identity', async () => {
    const { project, worktree } = await insertProject({ slug: 'alpha', commands: { test: 'npm run test' } });
    await mod.createEnvVar(ctx, project.id, { key: 'TOKEN_X', value: 'valeur-claire', secret: true });
    const { runId } = await mod.startRun(ctx, { projectId: project.id, kind: 'test' });
    expect(runId).toBe('22222222-2222-4222-8222-222222222222');
    const call = state.calls.find((c) => c.name === 'createRun')!;
    expect(call.environmentId).toBe(TEST_ENVIRONMENT_ID);
    expect((call.input as { body: Record<string, unknown> }).body).toMatchObject({
      projectId: project.id,
      worktreeId: worktree.id,
      kind: 'test',
      command: 'npm run test',
      env: { TOKEN_X: 'valeur-claire' },
      actorUserId: TEST_USER_ID,
      gitIdentity: { name: ctx.user.name, email: ctx.user.email },
    });
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain('valeur-claire');
  });

  it("uses the account's Git identity from its preferences when set", async () => {
    const { userPreferences } = await import('@nuera/db/schema');
    const { invalidateSettingsCache } = await import('@/server/settings');
    await db.update(userPreferences).set({ gitAuthorName: 'Camille L.', gitAuthorEmail: 'camille@noreply.example' }).where(eq(userPreferences.userId, TEST_USER_ID));
    invalidateSettingsCache();
    const { project } = await insertProject({ slug: 'alpha', commands: { test: 'npm test' } });
    await mod.startRun(ctx, { projectId: project.id, kind: 'test' });
    expect((state.calls.find((c) => c.name === 'createRun')!.input as { body: Record<string, unknown> }).body.gitIdentity).toEqual({ name: 'Camille L.', email: 'camille@noreply.example' });
  });

  it('refuses a kind without command and a worktree of another project', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    const other = await insertProject({ slug: 'beta' });
    await expect(mod.startRun(ctx, { projectId: project.id, kind: 'build' })).rejects.toThrow(/Aucune commande de build/);
    await expect(mod.startRun(ctx, { projectId: project.id, kind: 'test', worktreeId: other.worktree.id, command: 'npm test' })).rejects.toThrow(/Worktree introuvable/);
  });

  it('reads the latest run per kind for the D04 badges', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    await db.insert(commandRuns).values([
      { projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, kind: 'test', command: 'npm run test', status: 'failed', startedAt: new Date(Date.now() - 60_000) },
      { projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, kind: 'test', command: 'npm run test', status: 'succeeded', startedAt: new Date(), details: { report: { counts: { passed: 10, failed: 0, skipped: 0, running: 0, total: 10, durationMs: 1, framework: 'vitest' }, tests: [], failures: [] } } },
    ]);
    const detail = await mod.getProjectDetail(ctx, project.id);
    expect(detail.runs.latest.test).toMatchObject({ status: 'succeeded', tests: { passed: 10, total: 10 } });
    // Runner parts degrade on their own (the runner double does not implement them).
    expect(detail.branches.ok).toBe(false);
    expect(detail.project.name).toBe('alpha');
    expect(detail.environment).toEqual({ id: TEST_ENVIRONMENT_ID, name: 'VPS-3' });
  });

  it('reads and stops a run of the space on its server, audited with the actor', async () => {
    const { project, worktree } = await insertProject({ slug: 'alpha' });
    const [run] = await db
      .insert(commandRuns)
      .values({ projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, worktreeId: worktree.id, kind: 'dev', command: 'npm run dev', status: 'running', outputTail: 'prêt' })
      .returning();
    const detail = await mod.getRunDetail(ctx, run!.id);
    expect(detail).toMatchObject({ live: false, outputTail: 'prêt', projectId: project.id, run: { worktreeName: 'alpha' } });
    await mod.stopRun(ctx, run!.id).catch(() => undefined);
    expect(state.calls.filter((c) => c.name === 'stopRun').map((c) => c.environmentId)).toEqual([TEST_ENVIRONMENT_ID]);
    expect(await mod.listRuns(ctx, { projectId: project.id })).toHaveLength(1);
  });
});

describe('favourite, archive, restore', () => {
  it('toggles the favourite and audits command changes', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    expect((await mod.updateProject(ctx, project.id, { favorite: true })).favorite).toBe(true);
    await mod.updateProject(ctx, project.id, { commands: { dev: 'npm run dev' } });
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row!.commands).toMatchObject({ dev: 'npm run dev' });
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'project.commands_updated'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ spaceId: TEST_SPACE_ID, environmentId: TEST_ENVIRONMENT_ID });
  });

  it('records the opening of a project of the space only', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    const other = await createTestAccount({ role: 'member', name: 'Camille Martin', environment: { configSource: 'db', name: 'VPS-4' } });
    await mod.markProjectOpened(other.ctx, project.id);
    expect((await db.select().from(projects).where(eq(projects.id, project.id)))[0]!.lastOpenedAt).toBeNull();
    await mod.markProjectOpened(ctx, project.id);
    expect((await db.select().from(projects).where(eq(projects.id, project.id)))[0]!.lastOpenedAt).not.toBeNull();
  });

  it('refuses to archive with a live session, then archives the ended ones with the project', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    const live = crypto.randomUUID();
    await db.insert(sessions).values([sessionOf(project.id, { id: live, title: 'live' }), sessionOf(project.id, { title: 'done', status: 'finished' })]);
    expect(await mod.getArchivePreview(ctx, project.id)).toEqual({ endedSessions: 1, liveSessions: 1, clone: { onDisk: null, sizeBytes: null } });
    await expect(mod.archiveProject(ctx, project.id)).rejects.toThrow(/active/);
    await db.update(sessions).set({ status: 'stopped' }).where(eq(sessions.id, live));
    expect(await mod.archiveProject(ctx, project.id)).toEqual({ archivedSessions: 2, clone: null });
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row!.archivedAt).not.toBeNull();
    expect((await mod.listProjects(ctx)).items).toHaveLength(0);
    const restored = await mod.restoreProject(ctx, project.id);
    expect(restored.archivedAt).toBeNull();
    expect((await db.select().from(auditLog).where(eq(auditLog.actorUserId, TEST_USER_ID))).map((r) => r.action)).toEqual(
      expect.arrayContaining(['project.archived', 'project.restored']),
    );
  });

  it('refuses a restore while the repository is tracked again on the same server', async () => {
    const { project } = await insertProject({ slug: 'alpha', archivedAt: new Date() });
    await insertProject({ slug: 'alpha-2', name: 'Alpha bis', githubFullName: 'atelier/alpha', path: '/srv/dev/alpha-2' });
    await expect(mod.restoreProject(ctx, project.id)).rejects.toThrow('atelier/alpha est déjà suivi par le projet « Alpha bis ».');
  });

  it('offers the clone with its measured size, deletes it after the archive, and reports a refusal', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    const wt = (id: string, sizeBytes: number | null, extra: Record<string, unknown> = {}) => ({ id, projectId: project.id, name: id.slice(0, 4), branch: 'main', baseBranch: null, path: '/srv/dev/alpha', isPrimary: false, status: 'active', createdAt: new Date().toISOString(), lastUsedAt: null, dirtyFiles: 0, ahead: 0, behind: 0, liveSessionId: null, sizeBytes, ...extra });
    state.worktreeList = [wt(crypto.randomUUID(), 2_000_000_000, { isPrimary: true }), wt(crypto.randomUUID(), 254_857_830), wt(crypto.randomUUID(), null, { status: 'removed' })];
    expect((await mod.getArchivePreview(ctx, project.id)).clone).toEqual({ onDisk: true, sizeBytes: 2_254_857_830 });

    // Refused by the runner (work only on the server): archived anyway, clone kept, both audited.
    state.cloneRemoval = { code: 'CONFLICT', message: "1 commit(s) n'existe(nt) que sur le serveur : poussez-les d'abord.", reason: 'CLONE_UNPUSHED' };
    const refused = await mod.archiveProject(ctx, project.id, { removeClone: true });
    expect(refused).toEqual({ archivedSessions: 0, clone: { removed: false, message: "1 commit(s) n'existe(nt) que sur le serveur : poussez-les d'abord.", untouched: "Rien n'a été supprimé du disque." } });
    const [archived] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(archived!.archivedAt).not.toBeNull();

    // Asked again on the archived project: removed this time.
    state.cloneRemoval = null;
    expect(await mod.archiveProject(ctx, project.id, { removeClone: true })).toEqual({ archivedSessions: 0, clone: { removed: true, freedBytes: 2_254_857_830 } });
    expect(state.calls.filter((c) => c.name === 'removeClone').map((c) => [c.input, c.environmentId])).toEqual([
      [{ params: { projectId: project.id } }, TEST_ENVIRONMENT_ID],
      [{ params: { projectId: project.id } }, TEST_ENVIRONMENT_ID],
    ]);
    const audits = (await db.select().from(auditLog).where(eq(auditLog.targetId, project.id))).map((r) => r.action);
    expect(audits).toEqual(expect.arrayContaining(['project.archived', 'project.clone_remove_refused', 'project.clone_removed']));
  });

  it('removes only a project whose clone failed', async () => {
    const ready = await insertProject({ slug: 'alpha' });
    const failed = await insertProject({ slug: 'beta', status: 'error' });
    await expect(mod.discardFailedProject(ctx, ready.project.id)).rejects.toThrow();
    await mod.discardFailedProject(ctx, failed.project.id);
    expect((await db.select().from(projects)).map((r) => r.slug)).toEqual(['alpha']);
  });
});

describe('getProjectDetail', () => {
  it.each(['down', 'timeout'] as const)('keeps the DB parts and degrades each runner part when VPS-3 is %s', async (reads) => {
    state.reads = reads;
    const { project } = await insertProject({ slug: 'alpha', name: 'Alpha' });
    await db.insert(sessions).values(sessionOf(project.id, { title: 'en cours' }));
    await mod.createEnvVar(ctx, project.id, { key: 'API_URL', value: 'https://exemple.test', secret: false });
    const detail = await mod.getProjectDetail(ctx, project.id);
    expect(detail.project.name).toBe('Alpha');
    expect(detail.runnerAvailable).toBe(false);
    for (const part of [detail.branches, detail.worktrees, detail.status, detail.claudeMd]) {
      expect(part).toMatchObject({ ok: false, unavailable: true });
    }
    expect(detail.branches).toMatchObject({ message: 'VPS-3 ne répond pas : cette partie revient dès que le serveur répond.' });
    expect(detail.env.map((v) => v.key)).toEqual(['API_URL']);
    expect(detail.sessions.items.map((s) => s.title)).toEqual(['en cours']);
    expect(detail.sessions.liveSessionId).not.toBeNull();
    expect(detail.counts).toMatchObject({ branches: null, env: 1, sessions: 1 });
  });

  it('does not read the clone of a project that is not ready', async () => {
    const { project } = await insertProject({ slug: 'alpha', status: 'error' });
    const detail = await mod.getProjectDetail(ctx, project.id);
    expect(detail.branches).toMatchObject({ ok: false, unavailable: false, message: "Le clone n'existe pas sur VPS-3 : le clonage a échoué." });
    expect(state.calls.some((call) => ['listBranches', 'readClaudeMd'].includes(call.name))).toBe(false);
  });
});

describe('retryProjectClone', () => {
  it('retries only a failed clone, into another folder when asked', async () => {
    const ready = await insertProject({ slug: 'alpha' });
    await expect(mod.retryProjectClone(ctx, ready.project.id, {})).rejects.toThrow('Ce projet est déjà cloné sur VPS-3.');
    const failed = await insertProject({ slug: 'beta', status: 'error' });
    const result = await mod.retryProjectClone(ctx, failed.project.id, { destination: 'beta-2' });
    expect(result.projectId).toBe(failed.project.id);
    const [row] = await db.select().from(projects).where(eq(projects.id, failed.project.id));
    expect(row!.path).toBe('/srv/dev/beta-2');
    const clone = state.calls.find((call) => call.name === 'cloneRepo')!.input as { body: { destination: string } };
    expect(clone.body.destination).toBe('/srv/dev/beta-2');
    expect(state.github.find((c) => c.name === 'getGitAuthForProject')?.input).toMatchObject({ projectId: failed.project.id, access: 'read' });
  });

  it('audits a CLAUDE.md write (authored with the Git identity) and a worktree removal (never the file content)', async () => {
    const { project } = await insertProject({ slug: 'gamma' });
    await mod.writeProjectClaudeMd(ctx, project.id, { content: '# Règles\nNe jamais pousser sur main.' });
    const write = state.calls.find((call) => call.name === 'writeClaudeMd')!.input as { body: { commit: { author: unknown } } };
    expect(write.body.commit.author).toEqual({ name: ctx.user.name, email: ctx.user.email });
    const [written] = await db.select().from(auditLog).where(eq(auditLog.action, 'project.claude_md_written'));
    expect(written).toMatchObject({ actorUserId: TEST_USER_ID, targetId: project.id });
    expect(written!.summary).toContain('CLAUDE.md de gamma modifié (12 lignes), commit c0ffee1');
    expect(JSON.stringify(written)).not.toContain('Ne jamais pousser');

    const [extra] = await db
      .insert(worktrees)
      .values({ projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, name: 'export-csv', branch: 'feature/export-csv', path: '/srv/dev/.worktrees/gamma/export-csv' })
      .returning();
    const extraId = extra!.id;
    state.worktreeList = [
      { id: extraId, name: 'export-csv', branch: 'feature/export-csv', baseBranch: 'main', path: '/srv/dev/.worktrees/gamma/export-csv', isPrimary: false, status: 'ready', createdAt: new Date().toISOString(), lastUsedAt: null, dirtyFiles: 0, ahead: 0, behind: 0, liveSessionId: null },
    ];
    await mod.removeProjectWorktree(ctx, project.id, extraId, { deleteBranch: true });
    expect(state.calls.find((call) => call.name === 'removeWorktree')?.input).toEqual({ params: { worktreeId: extraId }, query: { force: false, deleteBranch: true } });
    const [removed] = await db.select().from(auditLog).where(eq(auditLog.action, 'project.worktree_removed'));
    expect(removed).toMatchObject({ actorUserId: TEST_USER_ID, targetType: 'worktree', targetId: extraId });
    expect(removed!.summary).toBe('worktree export-csv (feature/export-csv) supprimé de gamma, branche conservée');
  });

  it("refuses a worktree of another project before asking the runner", async () => {
    const alpha = await insertProject({ slug: 'alpha' });
    const beta = await insertProject({ slug: 'beta' });
    await expect(mod.previewWorktreeRemoval(ctx, alpha.project.id, beta.worktree.id)).rejects.toThrow('Worktree introuvable : il a peut-être déjà été supprimé.');
    expect(state.calls.some((call) => call.name === 'listWorktrees')).toBe(false);
  });

  it('refuses an invalid starting branch before touching anything', async () => {
    await expect(
      mod.createProject(ctx, { fullName: 'atelier/roux-conseil', name: 'Roux', destination: 'roux', branch: 'main..x', commands: {} }),
    ).rejects.toThrow();
    expect(state.calls.filter((call) => call.name === 'cloneRepo')).toHaveLength(0);
    expect(await db.select().from(projects)).toHaveLength(0);
  });
});

describe('another space', () => {
  let other: TestAccount;
  beforeEach(async () => {
    other = await createTestAccount({ role: 'member', name: 'Camille Martin', environment: { configSource: 'db', name: 'VPS-4' } });
  });

  it('answers every project function exactly like an unknown id, with no runner call and nothing written', async () => {
    const { project, worktree } = await insertProject({ slug: 'alpha', commands: { test: 'npm test' } });
    const unknown = crypto.randomUUID();
    const before = JSON.stringify(await db.select().from(projects));
    const auditsBefore = (await db.select().from(auditLog)).length;
    state.calls = [];
    const calls: Array<[string, (id: string) => Promise<unknown>]> = [
      ['detail', (id) => mod.getProjectDetail(other.ctx, id)],
      ['update', (id) => mod.updateProject(other.ctx, id, { name: 'Volé' })],
      ['archive', (id) => mod.archiveProject(other.ctx, id, { removeClone: true })],
      ['preview', (id) => mod.getArchivePreview(other.ctx, id)],
      ['restore', (id) => mod.restoreProject(other.ctx, id)],
      ['discard', (id) => mod.discardFailedProject(other.ctx, id)],
      ['retry', (id) => mod.retryProjectClone(other.ctx, id, {})],
      ['sync', (id) => mod.syncProject(other.ctx, id)],
      ['branches', (id) => mod.listProjectBranches(other.ctx, id)],
      ['branch', (id) => mod.createProjectBranch(other.ctx, id, { name: 'x' })],
      ['checkout', (id) => mod.checkoutProjectBranch(other.ctx, id, { branch: 'main' })],
      ['worktrees', (id) => mod.listProjectWorktrees(other.ctx, id)],
      ['wt-preview', (id) => mod.previewWorktreeRemoval(other.ctx, id, worktree.id)],
      ['wt-remove', (id) => mod.removeProjectWorktree(other.ctx, id, worktree.id, { force: true })],
      ['claude-md', (id) => mod.readProjectClaudeMd(other.ctx, id)],
      ['claude-md-write', (id) => mod.writeProjectClaudeMd(other.ctx, id, { content: 'x' })],
      ['env', (id) => mod.listEnvVars(other.ctx, id)],
      ['env-create', (id) => mod.createEnvVar(other.ctx, id, { key: 'X', value: 'y', secret: true })],
      ['mcp', (id) => mod.setProjectMcpTool(other.ctx, id, 'figma', true)],
      ['run', (id) => mod.startRun(other.ctx, { projectId: id, kind: 'test' })],
      ['runs', (id) => mod.listRuns(other.ctx, { projectId: id })],
    ];
    for (const [label, call] of calls) {
      const foreign = (await call(project.id).catch((e: unknown) => e)) as Error & { code?: string };
      const missing = (await call(unknown).catch((e: unknown) => e)) as Error & { code?: string };
      expect([label, foreign.code, foreign.message]).toEqual([label, 'NOT_FOUND', missing.message]);
      expect(missing.code).toBe('NOT_FOUND');
    }
    await mod.markProjectOpened(other.ctx, project.id);
    expect(state.calls).toHaveLength(0);
    expect(JSON.stringify(await db.select().from(projects))).toBe(before);
    expect((await db.select().from(auditLog)).length).toBe(auditsBefore);
  });

  it('answers « Lancement introuvable. » for a run of another space', async () => {
    const { project, worktree } = await insertProject({ slug: 'alpha' });
    const [run] = await db
      .insert(commandRuns)
      .values({ projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, worktreeId: worktree.id, kind: 'dev', command: 'npm run dev', status: 'running' })
      .returning();
    state.calls = [];
    await expect(mod.getRunDetail(other.ctx, run!.id)).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Lancement introuvable.' });
    await expect(mod.stopRun(other.ctx, run!.id)).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Lancement introuvable.' });
    expect(state.calls).toHaveLength(0);
  });
});
