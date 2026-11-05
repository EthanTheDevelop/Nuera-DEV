import { auditLog, commandRuns, operations, projectEnvVars, projects, sessions, worktrees } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ACTOR, TEST_USER_ID, closeProjectsDb, prepareProjectsDatabase, resetProjectTables, useTestEncryptionKey } from './test/db';

/*
 * Projets server module against a real database (nuera_projects_core), with runner and GitHub
 * doubles: list (filters, counters, favourites first, sync/conflict, sessions), creation (A4 refusal
 * writes nothing, clone with a READ token, runner failure removes the row), sync T4 copy, runs
 * (decrypted variables), env vars (secrets never returned, encrypted at rest), archive / restore.
 */

const state = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: unknown }>,
  destination: { available: true, exists: false, empty: true, fileCount: 0, suggestedPath: null as string | null },
  cloneFailure: null as null | { code: string; message: string; reason?: string },
  pullFailure: null as null | { code: string; message: string; reason?: string; data?: Record<string, unknown> },
}));

vi.mock('@/server/runner/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/runner/client')>();
  const record = (name: string, input: unknown) => state.calls.push({ name, input });
  const sync = { projectId: '00000000-0000-4000-8000-000000000000', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, state: 'up_to_date', lastFetchedAt: null, headSha: null, headMessage: null, headDate: null, dirtyFiles: 0 };
  return {
    ...original,
    runner: {
      systemMetrics: async () => {
        throw new original.RunnerError('RUNNER_UNAVAILABLE', 'VPS-3 ne répond pas.');
      },
      checkDestination: async (input: { body: { path: string } }) => {
        record('checkDestination', input);
        const path = input.body.path.startsWith('/') ? input.body.path : `/srv/dev/${input.body.path}`;
        return { path, existingClone: null, ...state.destination };
      },
      cloneRepo: async (input: { body: { projectId: string } }) => {
        record('cloneRepo', input);
        if (state.cloneFailure) {
          const f = state.cloneFailure;
          throw new original.RunnerError(f.code as never, f.message, f.reason ? { reason: f.reason } : {});
        }
        const operation = { id: '11111111-1111-4111-8111-111111111111' };
        return { operationId: operation.id, operation };
      },
      pullRepo: async (input: unknown) => {
        record('pullRepo', input);
        if (state.pullFailure) {
          const f = state.pullFailure;
          throw new original.RunnerError(f.code as never, f.message, { ...(f.reason ? { reason: f.reason } : {}), ...(f.data ? { data: f.data } : {}), untouched: "Aucun commit ni fichier local n'a été modifié." });
        }
        return { operationId: null, outcome: 'fast_forward', before: 'a', after: 'b', commits: 2, sync };
      },
      fetchRepo: async (input: unknown) => {
        record('fetchRepo', input);
        return { operationId: null, sync };
      },
      createRun: async (input: { body: Record<string, unknown> }) => {
        record('createRun', input);
        return { id: '22222222-2222-4222-8222-222222222222', projectId: input.body.projectId, worktreeId: input.body.worktreeId, kind: input.body.kind, command: input.body.command, status: 'running', exitCode: null, pid: 1, port: null, summary: null, tests: null, startedAt: new Date().toISOString(), finishedAt: null, live: true };
      },
    },
  };
});

vi.mock('@/server/github', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/github')>();
  return {
    ...original,
    getRepo: async (fullName: string) => ({
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
    }),
    getGitAuthForRepo: async (fullName: string, access: string) => {
      state.calls.push({ name: 'getGitAuthForRepo', input: { fullName, access } });
      return { extraHeader: 'AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dGVzdA==', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    },
  };
});

const { db } = await import('@/server/db');
const mod = await import('./index');

async function insertProject(values: Partial<typeof projects.$inferInsert> & { slug: string }) {
  const [row] = await db
    .insert(projects)
    .values({
      name: values.slug,
      githubFullName: `atelier/${values.slug}`,
      cloneUrl: `https://github.com/atelier/${values.slug}.git`,
      path: `/srv/dev/${values.slug}`,
      status: 'ready',
      ...values,
    })
    .returning();
  const [wt] = await db.insert(worktrees).values({ projectId: row!.id, name: values.slug, branch: 'main', path: row!.path, isPrimary: true }).returning();
  return { project: row!, worktree: wt! };
}

beforeAll(async () => {
  useTestEncryptionKey();
  await prepareProjectsDatabase('core');
});
afterAll(async () => closeProjectsDb());
beforeEach(async () => {
  state.calls = [];
  state.destination = { available: true, exists: false, empty: true, fileCount: 0, suggestedPath: null };
  state.cloneFailure = null;
  state.pullFailure = null;
  await resetProjectTables();
});

describe('listProjects', () => {
  it('filters, counts, puts favourites first and summarises sessions', async () => {
    const a = await insertProject({ slug: 'alpha', name: 'Alpha', lastOpenedAt: new Date(Date.now() - 60_000) });
    const b = await insertProject({ slug: 'beta', name: 'Beta', isFavorite: true, lastOpenedAt: new Date(Date.now() - 3600_000) });
    await insertProject({ slug: 'gamma', name: 'Gamma', archivedAt: new Date() });
    await db.insert(sessions).values([
      { id: crypto.randomUUID(), projectId: a.project.id, title: 's1', status: 'running' },
      { id: crypto.randomUUID(), projectId: a.project.id, title: 's2', status: 'running' },
      { id: crypto.randomUUID(), projectId: b.project.id, title: 's3', status: 'interrupted' },
    ]);
    await db.insert(operations).values({ kind: 'pull', status: 'failed', projectId: b.project.id, error: { code: 'CONFLICT', message: 'x', reason: 'PULL_CONFLICT' } as never });

    const all = await mod.listProjects();
    expect(all.counts).toEqual({ all: 2, favorites: 1, archived: 1 });
    expect(all.items.map((item) => item.name)).toEqual(['Beta', 'Alpha']);
    expect(all.items[1]!.sessions).toMatchObject({ active: 2, total: 2 });
    expect(all.items[0]!.sync.conflict).toBe(true);
    expect(all.runnerAvailable).toBe(false);
    expect(all.disk).toBeNull();

    expect((await mod.listProjects({ filter: 'favoris' })).items.map((i) => i.name)).toEqual(['Beta']);
    expect((await mod.listProjects({ filter: 'archives' })).items.map((i) => i.name)).toEqual(['Gamma']);
    expect((await mod.listProjects({ q: 'ALP' })).items.map((i) => i.name)).toEqual(['Alpha']);
    expect((await mod.listProjects({ q: '%' })).items).toHaveLength(0);
  });

  it('marks a running fetch as « Synchronisation… »', async () => {
    const a = await insertProject({ slug: 'alpha' });
    await db.insert(operations).values({ kind: 'fetch', status: 'running', projectId: a.project.id });
    const [item] = (await mod.listProjects()).items;
    expect(item!.sync.syncing).toBe(true);
    expect(item!.operation?.kind).toBe('fetch');
  });
});

describe('createProject', () => {
  const input = { fullName: 'atelier/roux-conseil', name: 'Roux Conseil', destination: 'roux-conseil', installDeps: true, worktreePerSession: true, readClaudeMd: true, commands: {} };

  it('inserts the row (cloning) and clones with a READ token of that repository', async () => {
    const result = await mod.createProject(input, TEST_ACTOR);
    const [row] = await db.select().from(projects).where(eq(projects.id, result.projectId));
    expect(row).toMatchObject({ status: 'cloning', name: 'Roux Conseil', slug: 'roux-conseil', path: '/srv/dev/roux-conseil', githubFullName: 'atelier/roux-conseil' });
    expect(state.calls.find((c) => c.name === 'getGitAuthForRepo')?.input).toEqual({ fullName: 'atelier/roux-conseil', access: 'read' });
    const clone = state.calls.find((c) => c.name === 'cloneRepo')!.input as { body: Record<string, unknown> };
    expect(clone.body).toMatchObject({ projectId: result.projectId, destination: '/srv/dev/roux-conseil', installDeps: true });
    expect(String(clone.body.extraHeader)).toMatch(/^AUTHORIZATION: basic /);
    const logs = await db.select().from(auditLog).where(eq(auditLog.action, 'project.created'));
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('eC1hY2Nlc3MtdG9rZW46dGVzdA');
  });

  it('A4: a non-empty destination writes nothing and carries the suggestion', async () => {
    state.destination = { available: false, exists: true, empty: false, fileCount: 14, suggestedPath: '/srv/dev/roux-conseil-landing' };
    const error = await mod.createProject(input, TEST_ACTOR).catch((e: unknown) => e);
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
    await expect(mod.createProject(input, TEST_ACTOR)).rejects.toThrow('refus');
    expect(await db.select().from(projects)).toHaveLength(0);
  });

  it('refuses a repository already tracked', async () => {
    await insertProject({ slug: 'roux', githubFullName: 'atelier/roux-conseil' });
    const error = await mod.createProject(input, TEST_ACTOR).catch((e: unknown) => e);
    expect((error as InstanceType<typeof mod.ProjectError>).reason).toBe('ALREADY_TRACKED');
  });

  it('gives a unique slug when the name is taken', async () => {
    await insertProject({ slug: 'roux-conseil', githubFullName: 'autre/roux-conseil', path: '/srv/dev/ailleurs' });
    const result = await mod.createProject({ ...input, destination: '/srv/dev/second' }, TEST_ACTOR);
    const [row] = await db.select().from(projects).where(eq(projects.id, result.projectId));
    expect(row!.slug).toBe('roux-conseil-2');
  });
});

describe('syncProject', () => {
  it('fast-forwards with a read token and audits', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    const result = await mod.syncProject(project.id, TEST_ACTOR);
    expect(result).toMatchObject({ outcome: 'fast_forward', commits: 2 });
    expect(state.calls.find((c) => c.name === 'getGitAuthForRepo')?.input).toEqual({ fullName: 'atelier/alpha', access: 'read' });
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'project.synced'))).length).toBe(1);
  });

  it('maps PULL_DIVERGED to the T4 copy and keeps the reason', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    state.pullFailure = { code: 'CONFLICT', message: 'main et origin/main ont divergé', reason: 'PULL_DIVERGED', data: { ahead: 1, behind: 2, remoteUrl: 'https://x:secret@github.com' } };
    const error = await mod.syncProject(project.id, TEST_ACTOR).catch((e: unknown) => e);
    const body = (await mod.projectErrorResponse(error).json()) as { error: { message: string; reason: string; detail: string; data: Record<string, unknown> } };
    expect(body.error).toMatchObject({ message: 'La branche locale et origin ont divergé', reason: 'PULL_DIVERGED', detail: 'main et origin/main ont divergé' });
    expect(body.error.data).toEqual({ ahead: 1, behind: 2 });
  });

  it('falls back to a fetch when the branch has no upstream', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    state.pullFailure = { code: 'CONFLICT', message: 'pas sur origin', reason: 'NO_UPSTREAM' };
    const result = await mod.syncProject(project.id, TEST_ACTOR);
    expect(result.outcome).toBe('fetched');
    expect(state.calls.some((c) => c.name === 'fetchRepo')).toBe(true);
  });

  it('refuses an archived project', async () => {
    const { project } = await insertProject({ slug: 'alpha', archivedAt: new Date() });
    await expect(mod.syncProject(project.id, TEST_ACTOR)).rejects.toThrow(/archivé/);
  });
});

describe('environment variables', () => {
  it('never returns a secret value and stores everything encrypted', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    const secret = await mod.createEnvVar(project.id, { key: 'DATABASE_URL', value: 'postgres://u:tres-secret@db/x', secret: true }, TEST_ACTOR);
    const plain = await mod.createEnvVar(project.id, { key: 'NEXT_PUBLIC_SITE_URL', value: 'https://os.example', secret: false }, TEST_ACTOR);
    expect(secret.value).toBeNull();
    expect(plain.value).toBe('https://os.example');
    const listed = await mod.listEnvVars(project.id);
    expect(listed.map((v) => [v.key, v.value])).toEqual([
      ['DATABASE_URL', null],
      ['NEXT_PUBLIC_SITE_URL', 'https://os.example'],
    ]);
    const stored = JSON.stringify(await db.select().from(projectEnvVars));
    expect(stored).not.toContain('tres-secret');
    expect(stored).not.toContain('os.example');
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain('tres-secret');
  });

  it('requires a new value to make a secret visible, refuses protected names and duplicates', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    const v = await mod.createEnvVar(project.id, { key: 'API_KEY', value: 'k1', secret: true }, TEST_ACTOR);
    await expect(mod.updateEnvVar(project.id, { id: v.id, secret: false }, TEST_ACTOR)).rejects.toThrow(/nouvelle valeur/);
    const shown = await mod.updateEnvVar(project.id, { id: v.id, secret: false, value: 'public' }, TEST_ACTOR);
    expect(shown.value).toBe('public');
    await expect(mod.createEnvVar(project.id, { key: 'API_KEY', value: 'x', secret: true }, TEST_ACTOR)).rejects.toThrow(/existe déjà/);
    await expect(mod.createEnvVar(project.id, { key: 'ANTHROPIC_API_KEY', value: 'x', secret: true }, TEST_ACTOR)).rejects.toThrow();
    await expect(mod.createEnvVar(project.id, { key: 'NUERA_X', value: 'x', secret: true }, TEST_ACTOR)).rejects.toThrow();
    expect(await mod.deleteEnvVar(project.id, v.id, TEST_ACTOR)).toEqual({ deleted: true });
    expect(await mod.listEnvVars(project.id)).toHaveLength(0);
  });
});

describe('runs', () => {
  it('starts the configured command in the primary clone with the decrypted variables', async () => {
    const { project, worktree } = await insertProject({ slug: 'alpha', commands: { test: 'npm run test' } });
    await mod.createEnvVar(project.id, { key: 'TOKEN_X', value: 'valeur-claire', secret: true }, TEST_ACTOR);
    const { runId } = await mod.startRun({ projectId: project.id, kind: 'test' }, TEST_ACTOR);
    expect(runId).toBe('22222222-2222-4222-8222-222222222222');
    const call = state.calls.find((c) => c.name === 'createRun')!.input as { body: Record<string, unknown> };
    expect(call.body).toMatchObject({ projectId: project.id, worktreeId: worktree.id, kind: 'test', command: 'npm run test', env: { TOKEN_X: 'valeur-claire' } });
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain('valeur-claire');
  });

  it('refuses a kind without command and a worktree of another project', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    const other = await insertProject({ slug: 'beta' });
    await expect(mod.startRun({ projectId: project.id, kind: 'build' }, TEST_ACTOR)).rejects.toThrow(/Aucune commande de build/);
    await expect(mod.startRun({ projectId: project.id, kind: 'test', worktreeId: other.worktree.id, command: 'npm test' }, TEST_ACTOR)).rejects.toThrow(/Worktree introuvable/);
  });

  it('reads the latest run per kind for the D04 badges', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    await db.insert(commandRuns).values([
      { projectId: project.id, kind: 'test', command: 'npm run test', status: 'failed', startedAt: new Date(Date.now() - 60_000) },
      { projectId: project.id, kind: 'test', command: 'npm run test', status: 'succeeded', startedAt: new Date(), details: { report: { counts: { passed: 10, failed: 0, skipped: 0, running: 0, total: 10, durationMs: 1, framework: 'vitest' }, tests: [], failures: [] } } },
    ]);
    const detail = await mod.getProjectDetail(project.id);
    expect(detail.runs.latest.test).toMatchObject({ status: 'succeeded', tests: { passed: 10, total: 10 } });
    // Runner parts degrade on their own (the runner double does not implement them).
    expect(detail.branches.ok).toBe(false);
    expect(detail.project.name).toBe('alpha');
  });
});

describe('favourite, archive, restore', () => {
  it('toggles the favourite and audits command changes', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    expect((await mod.updateProject(project.id, { favorite: true }, TEST_ACTOR)).favorite).toBe(true);
    await mod.updateProject(project.id, { commands: { dev: 'npm run dev' } }, TEST_ACTOR);
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row!.commands).toMatchObject({ dev: 'npm run dev' });
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'project.commands_updated'))).length).toBe(1);
  });

  it('refuses to archive with a live session, then archives the ended ones with the project', async () => {
    const { project } = await insertProject({ slug: 'alpha' });
    const live = crypto.randomUUID();
    await db.insert(sessions).values([
      { id: live, projectId: project.id, title: 'live', status: 'running' },
      { id: crypto.randomUUID(), projectId: project.id, title: 'done', status: 'finished' },
    ]);
    expect(await mod.getArchivePreview(project.id)).toEqual({ endedSessions: 1, liveSessions: 1 });
    await expect(mod.archiveProject(project.id, TEST_ACTOR)).rejects.toThrow(/active/);
    await db.update(sessions).set({ status: 'stopped' }).where(eq(sessions.id, live));
    expect(await mod.archiveProject(project.id, TEST_ACTOR)).toEqual({ archivedSessions: 2 });
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row!.archivedAt).not.toBeNull();
    expect((await mod.listProjects()).items).toHaveLength(0);
    const restored = await mod.restoreProject(project.id, TEST_ACTOR);
    expect(restored.archivedAt).toBeNull();
    expect((await db.select().from(auditLog).where(eq(auditLog.actorUserId, TEST_USER_ID))).map((r) => r.action)).toEqual(
      expect.arrayContaining(['project.archived', 'project.restored']),
    );
  });

  it('removes only a project whose clone failed', async () => {
    const ready = await insertProject({ slug: 'alpha' });
    const failed = await insertProject({ slug: 'beta', status: 'error' });
    await expect(mod.discardFailedProject(ready.project.id, TEST_ACTOR)).rejects.toThrow();
    await mod.discardFailedProject(failed.project.id, TEST_ACTOR);
    expect((await db.select().from(projects)).map((r) => r.slug)).toEqual(['alpha']);
  });
});
