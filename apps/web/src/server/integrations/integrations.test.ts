import { mcpServers, projects } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDatabase, resetTables, useTestEncryptionKey } from './test/db';

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

async function createProject(name = 'Nuera OS', fullName = 'nuera-studio/nuera-os') {
  const { db } = await import('@/server/db');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const [project] = await db
    .insert(projects)
    .values({ slug, name, githubFullName: fullName, cloneUrl: `https://github.com/${fullName}.git`, path: `/srv/dev/${slug}`, status: 'ready' })
    .returning();
  return project!;
}

async function storeCoolify(status: 'connected' | 'expiring' | 'expired' | 'error', patch: Record<string, unknown> = {}) {
  const { coolifyConfigSchema, upsertCoolify } = await import('@/server/coolify/store');
  await upsertCoolify({
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
    const overview = await getIntegrationsOverview();
    expect(overview.diagnostics).toEqual([
      {
        target: 'coolify',
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
    const overview = await getIntegrationsOverview();
    expect(overview.diagnostics).toEqual([
      {
        target: 'coolify',
        tone: 'warn',
        title: 'Autorisation Coolify bientôt expirée',
        body: `Renouvelez l'accès avant le ${formatDayMonth(new Date(expiresAt))}.`,
        since: null,
        actions: [{ kind: 'reconnect', label: 'Renouveler', href: '/integrations/mcp/coolify' }],
      },
    ]);
  });

  it('uses the T7 « après » copy for GitHub and the GitHub action as destination', async () => {
    const { insertGithubApp, updateGithubApp } = await import('@/server/github/store');
    const { githubConfigSchema } = await import('@/server/github/types');
    await insertGithubApp(
      githubConfigSchema.parse({
        mode: 'app',
        appId: 4242,
        slug: 'nuera-dev-test',
        clientId: 'Iv23li',
        name: 'Nuera Dev · localhost:3104',
        htmlUrl: 'https://github.example.test/apps/nuera-dev-test',
        createdAt: new Date().toISOString(),
      }),
      { privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----', clientSecret: 'secret-0123456789', webhookSecret: null },
    );
    await updateGithubApp(
      (config) => ({
        ...config,
        failingSince: '2026-11-05T08:12:00.000Z',
        lastCheck: {
          id: 'c1',
          target: 'github',
          trigger: 'schedule',
          startedAt: '2026-11-05T08:12:00.000Z',
          durationMs: 10,
          steps: [],
          result: {
            status: 'expired',
            reason: "L'application GitHub a été désinstallée.",
            action: { label: 'Réautoriser sur GitHub', kind: 'external', url: '/api/integrations/github/install' },
          },
        },
      }),
      { status: 'expired' },
    );
    const { getIntegrationsOverview } = await import('./index');
    const [banner] = (await getIntegrationsOverview()).diagnostics;
    expect(banner).toMatchObject({
      target: 'github',
      tone: 'danger',
      title: "L'accès GitHub a été retiré",
      body: "L'application GitHub a été désinstallée. Synchronisation, push et pull requests suspendus. Le travail local continue.",
      actions: [
        { kind: 'journal', label: 'Voir le journal' },
        { kind: 'external', label: 'Réautoriser sur GitHub', href: '/api/integrations/github/install' },
      ],
    });
  });

  it('shows no failure banner for a server that was never authorised, but lists it for the owner', async () => {
    const project = await createProject();
    const { setProjectMcpServer } = await import('@/server/mcp/registry');
    await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'figma', enabled: true });
    const { db } = await import('@/server/db');
    await db.update(mcpServers).set({ status: 'needs_auth', lastError: 'Connexion requise dans Claude Code.' }).where(eq(mcpServers.name, 'figma'));
    const { getIntegrationsOverview } = await import('./index');
    const overview = await getIntegrationsOverview();
    expect(overview.diagnostics).toEqual([]);
    expect(overview.attention.items).toEqual([{ target: 'mcp:figma', label: 'Figma', status: 'needs_auth', badge: 'Connexion requise' }]);
  });
});
