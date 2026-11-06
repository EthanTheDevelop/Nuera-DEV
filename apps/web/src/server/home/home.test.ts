import { operations, permissionRequests, projects, pullRequests, sessions, worktrees } from '@nuera/db/schema';
import type { CommitSummary } from '@nuera/shared/runner';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerClient } from '@/server/runner/client';
import type { RequestContext } from '@/server/tenancy/context';
import { useTestEncryptionKey } from '@/server/tenancy/test/db';
import { createTestAccount, type TestAccount } from '@/server/tenancy/test/fixtures';
import { closeHomeTestDb, prepareHomeTestDatabase, resetHomeTables, TEST_ENVIRONMENT_ID, testContext } from './test/db';

// --- fake runner (the HTTP clients are replaced; their error classes are kept) -------------------
const runnerMock = {
  systemMetrics: vi.fn<RunnerClient['systemMetrics']>(),
  claudeStatus: vi.fn<RunnerClient['claudeStatus']>(),
  listSessions: vi.fn<RunnerClient['listSessions']>(),
  getSession: vi.fn<RunnerClient['getSession']>(),
  repoLog: vi.fn<RunnerClient['repoLog']>(),
};
/** Server of every runner client asked for (one entry per client created). */
const asked: string[] = [];
vi.mock('@/server/runner/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/runner/client')>();
  return {
    ...original,
    getRunnerForEnvironment: (environmentId: string) => {
      asked.push(environmentId);
      return runnerMock;
    },
  };
});
const overviewMock = vi.fn<(scope: { space: { id: string } }) => Promise<unknown>>();
vi.mock('@/server/integrations', () => ({ getIntegrationsOverview: (scope: { space: { id: string } }) => overviewMock(scope) }));

let owner: RequestContext;

async function db() {
  return (await import('@/server/db')).db;
}

async function unavailable(): Promise<never> {
  const { RunnerError } = await import('@/server/runner/errors');
  throw new RunnerError('RUNNER_UNAVAILABLE', 'Le serveur ne répond pas.');
}

function commit(sha: string, subject: string, authoredAt: string): CommitSummary {
  return { sha, shortSha: sha.slice(0, 7), subject, body: '', authorName: 'Camille', authorEmail: 'c@example.test', authoredAt };
}

const overview = {
  github: { status: 'connected', repoCount: 12 },
  mcp: {
    servers: [
      { name: 'figma', label: 'Figma', icon: 'figma', preset: 'figma', displayStatus: 'connected' },
      { name: 'coolify', label: 'Coolify', icon: 'rocket', preset: 'coolify', displayStatus: 'expired' },
      { name: 'playwright', label: 'Playwright', icon: 'globe2', preset: 'playwright', displayStatus: 'disabled' },
    ],
    total: 3,
  },
  diagnostics: [
    { target: 'coolify', tone: 'danger', title: 'Coolify ne répond plus', body: '', since: null, actions: [{ kind: 'reconnect', label: 'Reconnecter', href: '/integrations/mcp/coolify' }] },
  ],
  attention: { count: 1, items: [] },
};

beforeAll(async () => {
  useTestEncryptionKey();
  await prepareHomeTestDatabase('service');
});
afterAll(async () => {
  await closeHomeTestDb();
});
beforeEach(async () => {
  await resetHomeTables();
  owner = testContext();
  asked.length = 0;
  for (const fn of Object.values(runnerMock)) fn.mockReset();
  overviewMock.mockReset();
  overviewMock.mockResolvedValue(overview);
  runnerMock.listSessions.mockResolvedValue({ sessions: [], capacity: { live: 0, max: 4 } });
  runnerMock.getSession.mockImplementation(unavailable);
});

async function seedProject(slug: string, overrides: Partial<typeof projects.$inferInsert> = {}, account: Pick<RequestContext, 'space' | 'environment'> = owner) {
  const [project] = await (await db())
    .insert(projects)
    .values({
      spaceId: account.space.id,
      environmentId: account.environment!.id,
      slug,
      name: slug.replace(/-/g, ' '),
      githubFullName: `atelier-test/${slug}`,
      cloneUrl: `https://github.com/atelier-test/${slug}.git`,
      htmlUrl: `https://github.com/atelier-test/${slug}`,
      path: `/srv/dev/${slug}`,
      status: 'ready',
      currentBranch: 'main',
      syncState: 'up_to_date',
      ...overrides,
    })
    .returning();
  return project!;
}

describe("requêtes de l'accueil", () => {
  it('classe les projets récents par dernière activité et compte les projets', async () => {
    const { loadRecentProjects } = await import('./queries');
    await seedProject('ancien', { lastOpenedAt: new Date('2026-10-01T10:00:00Z'), createdAt: new Date('2026-09-01T10:00:00Z') });
    await seedProject('recent', { lastSyncedAt: new Date('2026-11-04T10:00:00Z'), isFavorite: true, syncState: 'behind', behindBy: 2 });
    await seedProject('archive', { archivedAt: new Date('2026-11-04T11:00:00Z') });
    await seedProject('clonage', { status: 'cloning', currentBranch: null, createdAt: new Date('2026-08-01T10:00:00Z'), lastOpenedAt: null });
    const { items, total, ever, sessionsEver } = await loadRecentProjects(owner, 4);
    expect(total).toBe(3);
    expect(ever).toBe(4);
    expect(sessionsEver).toBe(false);
    expect(items.map((p) => p.name)).toEqual(['recent', 'ancien', 'clonage']);
    expect(items[0]).toMatchObject({ favorite: true, sync: { state: 'behind', behind: 2, syncing: false }, branch: 'main' });
    expect(items[2]).toMatchObject({ branch: null, sync: { syncing: true } });
  });

  it("compte l'activité des sessions dans l'ordre des projets récents", async () => {
    const { loadRecentProjects } = await import('./queries');
    const old = await seedProject('ancien', { createdAt: new Date('2026-09-01T10:00:00Z') });
    await seedProject('recent', { lastSyncedAt: new Date('2026-11-04T10:00:00Z'), createdAt: new Date('2026-09-02T10:00:00Z') });
    await (await db()).insert(sessions).values({
      projectId: old.id,
      environmentId: TEST_ENVIRONMENT_ID,
      id: '00000000-0000-4000-8000-000000000009',
      title: 'Hier soir',
      status: 'finished',
      lastActivityAt: new Date('2026-11-05T09:00:00Z'),
    });
    const { items, sessionsEver } = await loadRecentProjects(owner, 4);
    expect(items.map((p) => p.name)).toEqual(['ancien', 'recent']);
    expect(items[0]?.lastActivityAt).toBe('2026-11-05T09:00:00.000Z');
    expect(sessionsEver).toBe(true);
  });

  it("lit les demandes d'autorisation en attente des sessions actives", async () => {
    const { loadPendingPermissions } = await import('./queries');
    const project = await seedProject('devis');
    const d = await db();
    await d.insert(sessions).values([
      { id: '00000000-0000-4000-8000-000000000001', projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, title: 'Tests e2e du devis', status: 'waiting_permission' },
      { id: '00000000-0000-4000-8000-000000000002', projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, title: 'Ancienne', status: 'finished' },
    ]);
    await d.insert(permissionRequests).values([
      { sessionId: '00000000-0000-4000-8000-000000000001', toolName: 'Bash', toolInput: {}, title: 'Claude demande à exécuter une commande', target: 'npm run test -- e2e' },
      { sessionId: '00000000-0000-4000-8000-000000000002', toolName: 'Bash', toolInput: {}, title: 'x', target: 'rm -rf dist' },
    ]);
    const pending = await loadPendingPermissions(owner);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ sessionTitle: 'Tests e2e du devis', projectName: 'devis', target: 'npm run test -- e2e', isCommand: true });
  });
});

describe('dernières modifications', () => {
  it('fusionne les historiques, sans doublon, et ne cite Claude Code que pour un commit de session', async () => {
    const { loadActivity } = await import('./activity');
    const project = await seedProject('devis');
    const d = await db();
    const [wt] = await d
      .insert(worktrees)
      .values({ projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, name: 'export-csv', branch: 'feature/export-csv', path: '/srv/dev/devis-wt', lastUsedAt: new Date('2026-11-04T10:00:00Z') })
      .returning();
    await d.insert(sessions).values({ id: '00000000-0000-4000-8000-000000000003', projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, worktreeId: wt!.id, title: 'Export CSV', status: 'waiting_input' });
    await d.insert(operations).values({ kind: 'commit', status: 'succeeded', projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, sessionId: '00000000-0000-4000-8000-000000000003', result: { sha: 'c'.repeat(40) } });
    await d.insert(pullRequests).values({ projectId: project.id, number: 42, title: 'Galerie photos', headBranch: 'feature/galerie', baseBranch: 'main', url: 'https://github.com/atelier-test/devis/pull/42', createdAt: new Date('2026-11-03T10:00:00Z') });
    runnerMock.repoLog.mockImplementation(async (input) => {
      const shared = commit('a'.repeat(40), 'feat: base', '2026-11-02T10:00:00Z');
      if (input.query?.worktreeId) return { commits: [commit('c'.repeat(40), 'feat: export CSV', '2026-11-04T09:00:00Z'), shared] };
      return { commits: [shared] };
    });
    const activity = await loadActivity(owner, [{ projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, projectName: 'Devis', htmlUrl: project.htmlUrl, fullName: project.githubFullName, worktreeId: null, branch: 'main' }]);
    expect(activity.error).toBeNull();
    expect(new Set(asked)).toEqual(new Set([TEST_ENVIRONMENT_ID]));
    expect(activity.items.map((e) => [e.kind, e.sha?.slice(0, 7) ?? e.number, e.branch, e.byClaude])).toEqual([
      ['commit', 'ccccccc', 'feature/export-csv', true],
      ['pull_request', 42, 'feature/galerie', false],
      ['commit', 'aaaaaaa', 'main', false],
    ]);
    expect(activity.items[1]?.message).toBe('Galerie photos : pull request ouverte vers main');
    expect(activity.items[0]?.href).toBe(`https://github.com/atelier-test/devis/commit/${'c'.repeat(40)}`);
    expect(activity.githubUrl).toBe('https://github.com/atelier-test/devis/commits/feature/export-csv');
  });

  it('garde les pull requests quand le serveur ne répond pas', async () => {
    const { loadActivity } = await import('./activity');
    const project = await seedProject('devis');
    await (await db()).insert(pullRequests).values({ projectId: project.id, number: 7, title: 'Tarifs', headBranch: 'fix/tarifs', baseBranch: 'main', url: 'https://github.com/atelier-test/devis/pull/7', state: 'merged' });
    runnerMock.repoLog.mockImplementation(unavailable);
    const activity = await loadActivity(owner, [{ projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, projectName: 'Devis', htmlUrl: null, fullName: project.githubFullName, worktreeId: null, branch: 'main' }]);
    expect(activity.incomplete).toBe(true);
    expect(activity.error).toBeNull();
    expect(activity.items).toHaveLength(1);
    expect(activity.items[0]?.message).toBe('Tarifs : pull request fusionnée dans main');
  });
});

describe('intégrations', () => {
  it('liste GitHub puis les serveurs MCP activés, le plus urgent en premier', async () => {
    const { buildIntegrations } = await import('./integrations');
    const result = buildIntegrations(overview as never);
    expect(result.rows.map((r) => [r.name, r.detail, r.badge.label])).toEqual([
      ['GitHub', '12 dépôts accessibles', 'Connecté'],
      ['Coolify', 'serveur MCP · développement', 'Expiré'],
      ['Figma', 'serveur MCP', 'Connecté'],
    ]);
    expect(result.inactiveMcp).toBe(1);
    expect(result.footer).toEqual({ text: 'Coolify : reconnecter pour relancer les déploiements de développement.', href: '/integrations/mcp/coolify' });
  });
});

describe('getHomeData', () => {
  it('rend une page complète même quand le serveur ne répond pas', async () => {
    const { getHomeData } = await import('./index');
    await seedProject('devis');
    runnerMock.systemMetrics.mockImplementation(unavailable);
    runnerMock.claudeStatus.mockImplementation(unavailable);
    runnerMock.listSessions.mockImplementation(unavailable);
    runnerMock.repoLog.mockImplementation(unavailable);
    const data = await getHomeData(owner);
    expect(data.firstName).toBe('Camille');
    expect(data.server?.availability).toBe('unavailable');
    expect(data.server?.metrics).toBeNull();
    expect(data.server?.name).toBe('VPS-3');
    expect(data.claude.state).toBe('unknown');
    expect(data.sessions.error).toBeNull();
    expect(data.sessions.verified).toBe(false);
    expect(data.projects.total).toBe(1);
    expect(data.activity.error).toBe('runner_unavailable');
    expect(data.integrations?.rows[0]?.name).toBe('GitHub');
  });

  it("traite un runner figé (délai dépassé) comme un serveur qui ne répond pas", async () => {
    const { getHomeData, runnerNotAnswering } = await import('./index');
    const { RunnerError } = await import('@/server/runner/errors');
    const timeout = async (): Promise<never> => {
      throw new RunnerError('UPSTREAM', "Le runner n'a pas répondu à temps.", { cause: new DOMException('délai', 'TimeoutError') });
    };
    expect(runnerNotAnswering(new RunnerError('UPSTREAM', 'Réponse invalide.'))).toBe(false);
    await seedProject('devis');
    runnerMock.systemMetrics.mockImplementation(timeout);
    runnerMock.claudeStatus.mockImplementation(timeout);
    runnerMock.repoLog.mockImplementation(timeout);
    const data = await getHomeData(owner);
    expect(data.server?.metrics).toBeNull();
    expect(data.claude.state).toBe('unknown');
    expect(data.activity.error).toBe('runner_unavailable');
  });

  it('assemble les tuiles depuis le runner, la base et le CLI', async () => {
    const { getHomeData } = await import('./index');
    const project = await seedProject('devis');
    const d = await db();
    await d.insert(sessions).values({
      id: '00000000-0000-4000-8000-000000000004',
      projectId: project.id,
      environmentId: TEST_ENVIRONMENT_ID,
      title: 'Tests e2e du devis',
      status: 'waiting_permission',
      currentActivity: 'En attente de votre autorisation',
      startedAt: new Date('2026-11-04T09:00:00Z'),
    });
    await d.insert(permissionRequests).values({ sessionId: '00000000-0000-4000-8000-000000000004', toolName: 'Bash', toolInput: {}, title: 'Commande', target: 'npm run test -- e2e' });
    runnerMock.systemMetrics.mockResolvedValue({
      sampledAt: '2026-11-04T10:00:00.000Z',
      hostname: 'vps-3',
      platform: 'linux',
      cpuPercent: 23,
      cpuCount: 4,
      load: [0, 0, 0],
      memory: { usedBytes: 5, totalBytes: 16, freeBytes: 11, source: 'os' },
      disk: { path: '/srv/dev', usedBytes: 61, totalBytes: 160, freeBytes: 99 },
      uptimeSec: 18 * 86_400,
      runnerUptimeSec: 100,
      sessions: { live: 1, max: 4 },
      runs: { live: 0 },
      terminals: { live: 0 },
    });
    runnerMock.claudeStatus.mockResolvedValue({
      checkedAt: '2026-11-04T10:00:00.000Z',
      installed: true,
      version: '2.1.0',
      auth: { loggedIn: true, authMethod: 'claude.ai', apiProvider: null, subscriptionType: 'max', loginExpiresAt: null, email: null, organization: null },
      state: 'connected',
      agents: null,
      error: null,
    });
    runnerMock.listSessions.mockImplementation(unavailable);
    runnerMock.repoLog.mockResolvedValue({ commits: [] });
    const data = await getHomeData(owner);
    expect(data.server).toMatchObject({ availability: 'available', uptimeSec: 18 * 86_400 });
    expect(data.claude).toMatchObject({ state: 'connected', plan: 'max', defaultModel: null });
    expect(data.sessions.items).toHaveLength(1);
    expect(data.sessions.items[0]?.pendingPermission?.target).toBe('npm run test -- e2e');
    expect(data.pending).toHaveLength(1);
    expect(data.quickResume?.id).toBe('00000000-0000-4000-8000-000000000004');
    expect(data.capacity.max).toBe(4);
    expect(data.onboarding).toEqual({ github: true, project: true, session: true });
    expect(overviewMock.mock.calls.at(-1)?.[0]).toMatchObject({ space: { id: owner.space.id } });
  });
});

describe('cloisonnement', () => {
  let other: TestAccount;
  beforeEach(async () => {
    other = await createTestAccount({ role: 'member', name: 'Léa Martin', environment: { configSource: 'db', name: 'VPS-4' } });
  });

  it("ne montre ni projets, ni demandes, ni pull requests, ni commits d'un autre espace", async () => {
    const { loadPendingPermissions, loadRecentProjects, loadRecentPullRequests, loadRecentWorktrees, loadSessionCommitShas } = await import('./queries');
    const project = await seedProject('devis');
    const d = await db();
    const [wt] = await d.insert(worktrees).values({ projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, name: 'x', branch: 'feature/x', path: '/srv/dev/x' }).returning();
    await d.insert(sessions).values({ id: '00000000-0000-4000-8000-000000000005', projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, worktreeId: wt!.id, title: 'Secret', status: 'waiting_permission' });
    await d.insert(permissionRequests).values({ sessionId: '00000000-0000-4000-8000-000000000005', toolName: 'Bash', toolInput: {}, title: 'x', target: 'cat secret' });
    await d.insert(operations).values({ kind: 'commit', status: 'succeeded', projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, sessionId: '00000000-0000-4000-8000-000000000005', result: { sha: 'd'.repeat(40) } });
    await d.insert(operations).values({ kind: 'fetch', status: 'running', projectId: project.id, environmentId: TEST_ENVIRONMENT_ID });
    await d.insert(pullRequests).values({ projectId: project.id, number: 1, title: 'Secret', headBranch: 'feature/x', baseBranch: 'main', url: 'https://github.com/atelier-test/devis/pull/1' });

    expect(await loadRecentProjects(other.ctx, 4)).toEqual({ items: [], total: 0, ever: 0, sessionsEver: false });
    expect(await loadPendingPermissions(other.ctx)).toEqual([]);
    expect(await loadRecentPullRequests(other.ctx)).toEqual([]);
    expect(await loadRecentWorktrees(other.ctx)).toEqual([]);
    expect((await loadSessionCommitShas(other.ctx)).size).toBe(0);
    // The owner still sees its own (and the running fetch marks its project as syncing).
    expect((await loadRecentProjects(owner, 4)).items[0]?.sync.syncing).toBe(true);
    expect((await loadRecentProjects(owner, 4)).sessionsEver).toBe(true);
    expect(await loadPendingPermissions(owner)).toHaveLength(1);
    expect((await loadSessionCommitShas(owner)).size).toBe(1);
  });

  it("lit l'accueil d'un compte sans serveur sans appeler aucun runner", async () => {
    const { getHomeData } = await import('./index');
    await seedProject('devis');
    const lonely = await createTestAccount({ role: 'member', name: 'Sans Serveur', environment: false });
    overviewMock.mockResolvedValue({ ...overview, github: { status: 'not_configured', repoCount: null } });
    asked.length = 0;
    const data = await getHomeData(lonely.ctx);
    expect(asked).toEqual([]);
    expect(data.server).toBeNull();
    expect(data.claude.state).toBe('unknown');
    expect(data.sessions).toEqual({ items: [], verified: false, error: 'no_environment' });
    expect(data.capacity).toEqual({ active: 0, max: 0 });
    expect(data.projects).toEqual({ total: 0, items: [] });
    expect(data.pending).toEqual([]);
    expect(data.onboarding).toEqual({ github: false, project: false, session: false });
    expect(data.firstName).toBe('Sans');
    expect(overviewMock.mock.calls.at(-1)?.[0]).toMatchObject({ space: { id: lonely.space.id }, environment: null });
    // A fallback token not checked yet: GitHub is neither ticked nor offered.
    overviewMock.mockResolvedValue({ ...overview, github: { status: 'pending', mode: 'fallback_token', repoCount: null } });
    const pending = await getHomeData(lonely.ctx);
    expect(pending.integrations?.rows[0]?.name).toBe('GitHub');
    expect(pending.onboarding.github).toBeNull();
  });

  it("lit le serveur de l'espace, jamais celui d'un autre", async () => {
    const { getHomeData } = await import('./index');
    runnerMock.systemMetrics.mockImplementation(unavailable);
    runnerMock.claudeStatus.mockImplementation(unavailable);
    runnerMock.listSessions.mockImplementation(unavailable);
    await seedProject('devis');
    asked.length = 0;
    const data = await getHomeData(other.ctx);
    expect(new Set(asked)).toEqual(new Set([other.environment!.id]));
    expect(data.server?.name).toBe('VPS-4');
    expect(data.projects.total).toBe(0);
  });
});
