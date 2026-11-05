import { notifications, projects, sessions } from '@nuera/db/schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, dumpIntegrationTables, prepareTestDatabase, resetTables, TEST_USER_ID, useTestEncryptionKey } from '@/server/integrations/test/db';
import { startFakeCoolify, type FakeCoolify } from './test/fake-coolify';

let fake: FakeCoolify;
const SCOPED = '67|abcdefghijklmnopqrstuvwxyz0123456789ABCD';
const TEAM = '68|ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxw';
const WRITER = '69|writewritewritewritewritewritewritewrite';

beforeAll(async () => {
  await prepareTestDatabase('coolify');
  useTestEncryptionKey();
  fake = await startFakeCoolify();
});

afterAll(async () => {
  await fake?.close();
  await closeTestDb();
});

beforeEach(async () => {
  await resetTables();
  fake.down = false;
  fake.mcp.forceStatus = null;
  fake.requests.length = 0;
  fake.tokens = [
    { value: SCOPED, scoped: true, abilities: ['read', 'read:sensitive'] },
    { value: TEAM, scoped: false, abilities: ['read'] },
    { value: WRITER, scoped: true, abilities: ['read', 'write'] },
  ];
  fake.environments = [{ project: 'Nuera OS', uuid: 'p1', envs: ['development', 'preview'] }];
  fake.applications = [];
  (globalThis as { __nueraCoolifyLastManualCheck?: number }).__nueraCoolifyLastManualCheck = 0;
});

describe('Coolify reconnect (D2)', () => {
  it('validates a scoped read token with GETs only, stores it encrypted and never returns it', async () => {
    const { reconnectCoolify } = await import('./index');
    const result = await reconnectCoolify({ baseUrl: fake.url, token: SCOPED }, { actorUserId: TEST_USER_ID });
    expect(result.settings).toMatchObject({
      configured: true,
      status: 'connected',
      tokenFingerprint: 'jeton n°67',
      scope: 'scoped',
      version: '4.6.0',
      mcpEnabled: true,
      productionVisible: false,
    });
    expect(result.settings.abilities.sort()).toEqual(['read', 'read:sensitive']);
    expect(result.validation.abilitiesSource).toBe('mcp_tools');
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    // REST calls were GET only; the only POSTs went to the MCP endpoint (initialize / tools/list).
    expect(fake.requests.filter((request) => request.path !== '/mcp').every((request) => request.method === 'GET')).toBe(true);
    expect(fake.mcp.methods).toEqual(expect.arrayContaining(['initialize', 'notifications/initialized', 'tools/list']));
    expect(fake.mcp.methods).not.toContain('tools/call');
    const dump = await dumpIntegrationTables();
    expect(dump).not.toContain(SCOPED);
    expect(dump).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(dump).toContain('integration.coolify.connected');
  });

  it('reports a whole-team token and refuses one that can see production', async () => {
    const { reconnectCoolify } = await import('./index');
    const team = await reconnectCoolify({ baseUrl: fake.url, token: TEAM });
    expect(team.settings.scope).toBe('team');
    expect(team.settings.teamName).toBe('Développement');
    fake.environments.push({ project: 'Nuera OS', uuid: 'p2', envs: ['production'] });
    await expect(reconnectCoolify({ token: TEAM })).rejects.toMatchObject({ code: 'VALIDATION', untouched: 'Le jeton précédent est conservé.' });
    const accepted = await reconnectCoolify({ token: TEAM, allowProductionVisible: true });
    expect(accepted.settings.productionVisible).toBe(true);
  });

  it('refuses a token with the write ability and an unknown token, storing nothing', async () => {
    const { getCoolifySettings, reconnectCoolify } = await import('./index');
    await expect(reconnectCoolify({ baseUrl: fake.url, token: WRITER })).rejects.toThrow(/droit write/);
    await expect(reconnectCoolify({ baseUrl: fake.url, token: '70|unknownunknownunknownunknown' })).rejects.toThrow(/refuse le jeton/);
    expect((await getCoolifySettings()).configured).toBe(false);
  });

  it('reports « Coolify injoignable » when the instance is down', async () => {
    const { reconnectCoolify } = await import('./index');
    fake.down = true;
    await expect(reconnectCoolify({ baseUrl: fake.url, token: SCOPED })).rejects.toMatchObject({ code: 'UPSTREAM' });
  });
});

describe('Coolify checks', () => {
  it('maps a revoked token to « expiré » at once and notifies; unreachable needs two failures', async () => {
    const { checkCoolify, reconnectCoolify } = await import('./index');
    await reconnectCoolify({ baseUrl: fake.url, token: SCOPED });
    expect((await checkCoolify({ trigger: 'schedule' })).status).toBe('connected');

    fake.down = true;
    const first = await checkCoolify({ trigger: 'schedule' });
    expect(first.status).toBe('connected'); // hysteresis: one transient failure is not enough
    expect(first.failingSince).not.toBeNull();
    const second = await checkCoolify({ trigger: 'schedule' });
    expect(second.status).toBe('error');

    fake.down = false;
    expect((await checkCoolify({ trigger: 'schedule' })).status).toBe('connected');

    fake.tokens[0]!.revoked = true;
    const expired = await checkCoolify({ trigger: 'schedule' });
    expect(expired.status).toBe('expired');
    expect(expired.reason).toBe('Coolify refuse le jeton.');

    const { db } = await import('@/server/db');
    const rows = await db.select().from(notifications);
    const titles = rows.map((row) => row.title);
    expect(titles.some((title) => title.startsWith('Coolify ne répond plus depuis'))).toBe(true);
    expect(titles).toContain("L'accès Coolify a été retiré");
  });

  it('warns before a declared expiry (T7 avant)', async () => {
    const { reconnectCoolify } = await import('./index');
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const result = await reconnectCoolify({ baseUrl: fake.url, token: SCOPED, expiresAt: soon });
    expect(result.settings.status).toBe('expiring');
    const { db } = await import('@/server/db');
    const [row] = await db.select().from(notifications);
    expect(row).toMatchObject({ kind: 'integration_expiring', title: 'Autorisation Coolify bientôt expirée' });
    expect(row?.body).toMatch(/^Renouvelez l'accès avant le \d{1,2} [a-zéû]+\.$/);
  });
});

describe('Coolify token refused → Coolify MCP server « expiré »', () => {
  it('marks the MCP server expired so D04 / D07 agree, and « à tester » again after a reconnection', async () => {
    const { checkCoolify, reconnectCoolify } = await import('./index');
    const { db } = await import('@/server/db');
    const { getProjectMcpTools, getMcpServer, setProjectMcpServer } = await import('@/server/mcp/registry');
    const [project] = await db
      .insert(projects)
      .values({ slug: 'nuera-os', name: 'Nuera OS', githubFullName: 'nuera-studio/nuera-os', cloneUrl: 'https://github.com/nuera-studio/nuera-os.git', path: '/srv/dev/nuera-os', status: 'ready' })
      .returning();
    await setProjectMcpServer({ projectId: project!.id, serverIdOrName: 'coolify', enabled: true });
    await reconnectCoolify({ baseUrl: fake.url, token: SCOPED });
    expect((await getMcpServer('coolify')).status).not.toBe('expired');

    fake.tokens[0]!.revoked = true;
    expect((await checkCoolify({ trigger: 'schedule' })).status).toBe('expired');
    const server = await getMcpServer('coolify');
    expect(server).toMatchObject({ status: 'expired', displayStatus: 'expired', lastError: 'Coolify refuse le jeton.' });
    const tools = await getProjectMcpTools(project!.id);
    expect(tools.find((tool) => tool.name === 'coolify')).toMatchObject({ status: 'expired', needsReconnect: true });
    // Only the Coolify notification, not a second one for its MCP server.
    const rows = await db.select().from(notifications);
    expect(rows.filter((row) => row.title.includes('Coolify'))).toHaveLength(1);

    fake.tokens[0]!.revoked = false;
    await reconnectCoolify({ token: SCOPED });
    expect((await getMcpServer('coolify')).status).toBe('unknown');
  });
});

describe('Coolify token and Claude (P4)', () => {
  it('keeps a token away from Claude until the MCP tool list proves it cannot write', async () => {
    const { reconnectCoolify } = await import('./index');
    const { db } = await import('@/server/db');
    const { setProjectMcpServer } = await import('@/server/mcp/registry');
    const { buildSessionMcpConfig } = await import('@/server/mcp/session-config');
    const { resolveSessionMcpHeaders } = await import('@/server/mcp/headers');
    const { checkMcpServer } = await import('@/server/mcp/diagnostics');
    const [project] = await db
      .insert(projects)
      .values({ slug: 'nuera-os', name: 'Nuera OS', githubFullName: 'nuera-studio/nuera-os', cloneUrl: 'https://github.com/nuera-studio/nuera-os.git', path: '/srv/dev/nuera-os', status: 'ready' })
      .returning();
    const [session] = await db.insert(sessions).values({ id: crypto.randomUUID(), projectId: project!.id, title: 'Module CRM', status: 'running' }).returning();
    await setProjectMcpServer({ projectId: project!.id, serverIdOrName: 'coolify', enabled: true });
    const headers = () => resolveSessionMcpHeaders({ sessionId: session!.id, serverName: 'coolify' });

    // MCP disabled on the instance while reconnecting: the abilities cannot be read.
    fake.mcp.forceStatus = 404;
    const unverified = await reconnectCoolify({ baseUrl: fake.url, token: WRITER });
    expect(unverified.validation.abilitiesSource).toBe('rest');
    expect(unverified.settings.warnings.some((warning) => warning.startsWith('Droits du jeton non vérifiés'))).toBe(true);
    const config = await buildSessionMcpConfig(project!.id);
    expect(config.mcpConfig.mcpServers.coolify).toBeUndefined();
    expect(config.skipped).toEqual([{ name: 'coolify', reason: expect.stringMatching(/non vérifiés/) }]);
    await expect(headers()).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // MCP enabled afterwards: the test lists write tools → error, the token stays refused.
    fake.mcp.forceStatus = null;
    const writer = await checkMcpServer('coolify', { trigger: 'schedule' });
    expect(writer.status).toBe('error');
    expect(writer.lastError).toMatch(/droit write/);
    await expect(headers()).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/droit write/) });

    // A read-only token, unverified at reconnection, is served once the MCP test has read its tools.
    fake.mcp.forceStatus = 404;
    await reconnectCoolify({ token: SCOPED });
    await expect(headers()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    fake.mcp.forceStatus = null;
    expect((await checkMcpServer('coolify', { trigger: 'schedule' })).status).toBe('connected');
    expect(await headers()).toEqual({ headers: { Authorization: `Bearer ${SCOPED}` }, expiresAt: null });
    expect(Object.keys((await buildSessionMcpConfig(project!.id)).mcpConfig.mcpServers)).toEqual(['coolify']);
  });
});

describe('Coolify ↔ projects', () => {
  it('maps applications to projects by repository, the project branch first', async () => {
    const { mapApplicationsToProjects, normalizeGitRepository } = await import('./index');
    expect(normalizeGitRepository('https://github.com/Nuera-Studio/nuera-os.git')).toBe('nuera-studio/nuera-os');
    expect(normalizeGitRepository('git@github.com:nuera-studio/nuera-os.git')).toBe('nuera-studio/nuera-os');
    expect(normalizeGitRepository('nuera-studio/nuera-os')).toBe('nuera-studio/nuera-os');
    const apps = [
      { uuid: 'a', name: 'nuera-os (main)', git_repository: 'nuera-studio/nuera-os', git_branch: 'main' },
      { uuid: 'b', name: 'nuera-os (crm)', git_repository: 'https://github.com/nuera-studio/nuera-os', git_branch: 'feature/crm-core' },
      { uuid: 'c', name: 'autre', git_repository: 'nuera-studio/autre', git_branch: 'main' },
    ];
    const mapped = mapApplicationsToProjects(apps, [{ id: 'p', githubFullName: 'nuera-studio/nuera-os', currentBranch: 'feature/crm-core' }]);
    expect(mapped.get('p')?.map((app) => app.uuid)).toEqual(['b', 'a']);
  });

  it('only exposes browser-safe deployment fields', async () => {
    const { reconnectCoolify, listCoolifyDeployments, toPublicDeployment } = await import('./index');
    await reconnectCoolify({ baseUrl: fake.url, token: SCOPED });
    const { deployments } = await listCoolifyDeployments('a');
    const view = deployments.map(toPublicDeployment);
    expect(view[0]).toMatchObject({ uuid: 'dep-1', status: 'finished', commit: 'a3f9c12' });
    expect(JSON.stringify(view)).not.toContain('secret log');
  });
});
