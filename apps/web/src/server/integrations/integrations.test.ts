import { githubSources, mcpServers, projects } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, type TestAccount } from '@/server/tenancy/test/fixtures';
import { closeTestDb, prepareTestDatabase, resetTables, testContext, TEST_ENVIRONMENT_ID, TEST_SPACE_ID, useTestEncryptionKey } from './test/db';

beforeAll(async () => {
  await prepareTestDatabase('overview');
  useTestEncryptionKey();
  process.env.APP_URL = 'http://localhost:3104';
  process.env.GITHUB_WEB_URL = 'https://github.example.test';
  delete process.env.GITHUB_FALLBACK_TOKEN;
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTables();
});

const COOLIFY_TOKEN = '67|abcdefghijklmnopqrstuvwxyz0123456789ABCD';
const ctx = () => testContext();

async function createProject(name = 'Nuera OS', fullName = 'nuera-studio/nuera-os', owner: { spaceId: string; environmentId: string } = { spaceId: TEST_SPACE_ID, environmentId: TEST_ENVIRONMENT_ID }) {
  const { db } = await import('@/server/db');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const [project] = await db
    .insert(projects)
    .values({ ...owner, slug, name, githubFullName: fullName, cloneUrl: `https://github.com/${fullName}.git`, path: `/srv/dev/${slug}`, status: 'ready' })
    .returning();
  return project!;
}

async function storeCoolify(status: 'connected' | 'expiring' | 'expired' | 'error', patch: Record<string, unknown> = {}, spaceId = TEST_SPACE_ID) {
  const { coolifyConfigSchema, upsertCoolify } = await import('@/server/coolify/store');
  await upsertCoolify({
    spaceId,
    config: coolifyConfigSchema.parse({
      baseUrl: 'https://coolify.example.test',
      tokenIdPrefix: '67',
      abilities: ['read', 'read:sensitive'],
      abilitiesSource: 'mcp_tools',
      connectedAt: '2026-11-01T08:00:00.000Z',
      ...patch,
    }),
    token: COOLIFY_TOKEN,
    status,
    checkedAt: new Date(),
  });
}

/** A GitHub source stored directly (no network), with a failing last check. */
async function storeGithubSource(options: { spaceId?: string; appId: number; label: string; status: 'connected' | 'expired'; failing?: boolean }) {
  const { insertGithubSource, updateGithubSource } = await import('@/server/github/store');
  const { githubConfigSchema } = await import('@/server/github/types');
  const id = crypto.randomUUID();
  const spaceId = options.spaceId ?? TEST_SPACE_ID;
  await insertGithubSource({
    id,
    spaceId,
    createdByUserId: null,
    label: options.label,
    config: githubConfigSchema.parse({
      mode: 'app',
      appId: options.appId,
      slug: `nuera-dev-${options.appId}`,
      clientId: 'Iv23li',
      name: `Nuera Dev ${options.appId}`,
      htmlUrl: `https://github.example.test/apps/nuera-dev-${options.appId}`,
      createdAt: new Date().toISOString(),
    }),
    secrets: { privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----', clientSecret: 'secret-0123456789', webhookSecret: null },
  });
  await updateGithubSource(
    { spaceId, sourceId: id },
    (config) =>
      options.failing
        ? {
            ...config,
            failingSince: '2026-11-05T08:12:00.000Z',
            lastCheck: {
              id: 'c1',
              target: `github:${id}`,
              trigger: 'schedule',
              startedAt: '2026-11-05T08:12:00.000Z',
              durationMs: 10,
              steps: [],
              result: {
                status: 'expired',
                reason: "L'application GitHub a été désinstallée.",
                // A check persisted before several sources: the historical install route.
                action: { label: 'Réautoriser sur GitHub', kind: 'external', url: '/api/integrations/github/install' },
              },
            },
          }
        : config,
    { status: options.status, lastCheckedAt: new Date('2026-11-05T08:12:00.000Z') },
  );
  return id;
}

async function otherSpace(): Promise<TestAccount> {
  return createTestAccount({ role: 'member', name: 'Camille Laurent', email: 'camille@example.test', environment: { configSource: 'db', name: 'VPS-4' } });
}

describe('getIntegrationsOverview — diagnostic banners (D07 216:2247, T7 236:5401)', () => {
  it('shows the Figma « Diagnostic Coolify » banner for a refused Coolify token, once', async () => {
    const project = await createProject();
    // 08:12 UTC = 09:12 in Paris (CET, November).
    await storeCoolify('expired', { failingSince: '2026-11-05T08:12:00.000Z' });
    const { setProjectMcpServer } = await import('@/server/mcp/registry');
    await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'coolify', enabled: true });
    const { db } = await import('@/server/db');
    await db.update(mcpServers).set({ status: 'expired', lastError: 'Autorisation expirée' }).where(eq(mcpServers.name, 'coolify'));

    const { getIntegrationsOverview } = await import('./index');
    const overview = await getIntegrationsOverview(ctx());
    expect(overview.diagnostics).toEqual([
      {
        target: 'coolify',
        service: 'coolify',
        sourceId: null,
        tone: 'danger',
        title: 'Coolify ne répond plus depuis 09:12',
        body: 'Le jeton du serveur MCP a expiré. Les sessions de Nuera OS continuent, sans accès aux environnements de développement.',
        since: '2026-11-05T08:12:00.000Z',
        actions: [
          { kind: 'journal', label: 'Voir le journal', href: '/integrations?journal=coolify' },
          { kind: 'reconnect', label: 'Reconnecter', href: '/integrations/mcp/coolify' },
        ],
      },
    ]);
    expect(overview.attention.items.map((item) => item.target)).toEqual(['coolify']);
    expect(JSON.stringify(overview)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('warns before a declared expiry (T7 avant) with « Renouveler »', async () => {
    const expiresAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await storeCoolify('expiring', { declaredExpiresAt: expiresAt });
    const { formatDayMonth } = await import('./transitions');
    const { getIntegrationsOverview } = await import('./index');
    const overview = await getIntegrationsOverview(ctx());
    expect(overview.diagnostics).toEqual([
      {
        target: 'coolify',
        service: 'coolify',
        sourceId: null,
        tone: 'warn',
        title: 'Autorisation Coolify bientôt expirée',
        body: `Renouvelez l'accès avant le ${formatDayMonth(new Date(expiresAt))}.`,
        since: null,
        actions: [{ kind: 'reconnect', label: 'Renouveler', href: '/integrations/mcp/coolify' }],
      },
    ]);
  });

  it('uses the T7 « après » copy for the single GitHub source and its own action as destination', async () => {
    const sourceId = await storeGithubSource({ appId: 4242, label: 'nuera-studio', status: 'expired', failing: true });
    const { getIntegrationsOverview } = await import('./index');
    const [banner] = (await getIntegrationsOverview(ctx())).diagnostics;
    expect(banner).toMatchObject({
      target: 'github',
      service: 'github',
      sourceId,
      tone: 'danger',
      title: "L'accès GitHub a été retiré",
      body: "L'application GitHub a été désinstallée. Synchronisation, push et pull requests suspendus. Le travail local continue.",
      actions: [
        { kind: 'journal', label: 'Voir le journal', href: '/integrations?journal=github' },
        { kind: 'external', label: 'Réautoriser sur GitHub', href: `/api/integrations/github/install?source=${sourceId}` },
      ],
    });
  });

  it('shows one banner per failing source among several, named after the source', async () => {
    await storeGithubSource({ appId: 4242, label: 'nuera-studio', status: 'connected' });
    const failing = await storeGithubSource({ appId: 5151, label: 'ethanthedevelop', status: 'expired', failing: true });
    const { getIntegrationsOverview } = await import('./index');
    const overview = await getIntegrationsOverview(ctx());
    expect(overview.github).toMatchObject({ status: 'expired', reason: '1 source sur 2 à réautoriser', sourceCount: 2 });
    expect(overview.diagnostics).toMatchObject([
      {
        target: `github:${failing}`,
        service: 'github',
        sourceId: failing,
        title: "L'accès GitHub · ethanthedevelop a été retiré",
        actions: [{ kind: 'journal', href: `/integrations?journal=github&source=${failing}` }, { kind: 'external' }],
      },
    ]);
    expect(overview.attention.items).toEqual([{ target: `github:${failing}`, label: 'GitHub · ethanthedevelop', status: 'expired', badge: 'Autorisation expirée' }]);
  });

  it('shows no failure banner for a server that was never authorised, but lists it for the owner', async () => {
    const project = await createProject();
    const { setProjectMcpServer } = await import('@/server/mcp/registry');
    await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'figma', enabled: true });
    const { db } = await import('@/server/db');
    await db.update(mcpServers).set({ status: 'needs_auth', lastError: 'Connexion requise dans Claude Code.' }).where(eq(mcpServers.name, 'figma'));
    const { getIntegrationsOverview } = await import('./index');
    const overview = await getIntegrationsOverview(ctx());
    expect(overview.diagnostics).toEqual([]);
    expect(overview.attention.items).toEqual([{ target: 'mcp:figma', label: 'Figma', status: 'needs_auth', badge: 'Connexion requise' }]);
  });
});

describe('getIntegrationsOverview — one space', () => {
  it("never shows another space's sources, Coolify, MCP activations, banners nor last run", async () => {
    const { db } = await import('@/server/db');
    const b = await otherSpace();
    // Everything failing in A.
    const project = await createProject();
    await storeCoolify('expired', { failingSince: '2026-11-05T08:12:00.000Z' });
    await storeGithubSource({ appId: 4242, label: 'nuera-studio', status: 'expired', failing: true });
    const { setProjectMcpServer } = await import('@/server/mcp/registry');
    await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'figma', enabled: true });
    await db.update(mcpServers).set({ status: 'expired', lastCheckedAt: new Date('2026-11-05T08:00:00Z') }).where(eq(mcpServers.spaceId, TEST_SPACE_ID));

    const { getIntegrationsOverview } = await import('./index');
    const overview = await getIntegrationsOverview(b.ctx);
    expect(overview.github).toMatchObject({ mode: 'none', status: 'not_configured', sources: [] });
    expect(overview.coolify.configured).toBe(false);
    expect(overview.diagnostics).toEqual([]);
    expect(overview.attention).toEqual({ count: 0, items: [] });
    expect(overview.guardrails.autoCheck.lastRunAt).toBeNull();
    expect(overview.mcp.servers.every((server) => server.projects.length === 0 && server.displayStatus === 'disabled')).toBe(true);
    expect(JSON.stringify(overview)).not.toContain(project.id);
    // A still sees its own.
    const own = await getIntegrationsOverview(ctx());
    expect(own.attention.count).toBeGreaterThan(0);
    expect(await db.select().from(githubSources).where(and(eq(githubSources.spaceId, b.space.id)))).toHaveLength(0);
  });

  it('runs the checks of one space only (scheduler and internal route)', async () => {
    const b = await otherSpace();
    await storeCoolify('connected', {}, b.space.id);
    const { runIntegrationChecks } = await import('./index');
    // A has nothing configured: nothing checked, B's Coolify untouched.
    const summary = await runIntegrationChecks({ spaceId: TEST_SPACE_ID, trigger: 'schedule' });
    expect(summary).toMatchObject({ spaceId: TEST_SPACE_ID, github: null, githubSources: [], coolify: null, mcp: [] });
    const { getCoolifySettings } = await import('@/server/coolify');
    expect((await getCoolifySettings(b.space.id)).lastCheck).toBeNull();
  });
});
