import { mcpServers, notifications, projectMcpServers, projects, sessionEvents, sessions } from '@nuera/db/schema';
import type { McpCliStatus, TerminalDto } from '@nuera/shared/runner';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  allowLocalFakes,
  closeTestDb,
  dumpIntegrationTables,
  prepareTestDatabase,
  resetTables,
  TEST_ENVIRONMENT_ID,
  TEST_SPACE_ID,
  TEST_USER_ID,
  testContext,
  useTestEncryptionKey,
} from '@/server/integrations/test/db';
import { createTestAccount, type TestAccount } from '@/server/tenancy/test/fixtures';
import type { McpRunnerPort } from './diagnostics';
import { startFakeMcp } from './test/fake-mcp';

const S = TEST_SPACE_ID;
const ref = (idOrName: string) => ({ spaceId: S, idOrName });

beforeAll(async () => {
  await prepareTestDatabase('mcp');
  useTestEncryptionKey();
  allowLocalFakes();
  process.env.APP_URL = 'http://localhost:3104';
  delete process.env.GITHUB_FALLBACK_TOKEN;
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTables();
});

async function createProject(name = 'Nuera OS', fullName = 'nuera-studio/nuera-os', owner: { spaceId: string; environmentId: string } = { spaceId: S, environmentId: TEST_ENVIRONMENT_ID }) {
  const { db } = await import('@/server/db');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const [project] = await db
    .insert(projects)
    .values({ ...owner, slug, name, githubFullName: fullName, cloneUrl: `https://github.com/${fullName}.git`, path: `/srv/dev/${slug}-${owner.spaceId.slice(0, 4)}`, status: 'ready' })
    .returning();
  return project!;
}

async function otherSpace(environment: false | { name: string } = { name: 'VPS-4' }): Promise<TestAccount> {
  return createTestAccount({
    role: 'member',
    name: 'Camille Laurent',
    email: 'camille@example.test',
    environment: environment === false ? false : { configSource: 'db', name: environment.name },
  });
}

function fakePort(states: Record<string, McpCliStatus['state']>): McpRunnerPort & { synced: string[]; logins: string[] } {
  const port = {
    synced: [] as string[],
    logins: [] as string[],
    async mcpGet(name: string): Promise<McpCliStatus> {
      const state = states[name] ?? 'not_configured';
      return { name, state, statusLine: state === 'connected' ? '✔ Connected' : '! Needs authentication', raw: `${name}:\n  Status: ${state}`, checkedAt: new Date().toISOString() };
    },
    async mcpSync(input: { upsert: Array<{ name: string; config: Record<string, unknown> }>; remove: string[] }) {
      port.synced.push(...input.upsert.map((item) => item.name));
      for (const item of input.upsert) states[item.name] = states[item.name] === 'not_configured' || !states[item.name] ? 'needs_auth' : states[item.name]!;
      return { results: input.upsert.map((item) => ({ name: item.name, action: 'upsert' as const, ok: true, raw: 'Added' })) };
    },
    async createLoginTerminal(serverName: string): Promise<TerminalDto> {
      port.logins.push(serverName);
      const now = new Date().toISOString();
      return { id: 'term_abcdefgh12', kind: 'mcp-login', title: `claude mcp login ${serverName}`, cwd: null, worktreeId: null, sessionId: null, cols: 120, rows: 32, alive: true, exitCode: null, private: true, subscribers: 0, createdAt: now, lastActivityAt: now };
    },
  };
  return port;
}

describe('MCP probe (Streamable HTTP)', () => {
  it('runs initialize + tools/list (paginated) and closes the session, in JSON and SSE modes', async () => {
    const { probeMcpServer } = await import('./probe');
    for (const mode of ['json', 'sse'] as const) {
      const server = await startFakeMcp({ expectedAuthorization: 'Bearer secret-token-123', tools: ['a', 'b', 'c', 'd', 'e'], mode, pageSize: 2 });
      try {
        const result = await probeMcpServer({ url: server.url, headers: { Authorization: 'Bearer secret-token-123' }, timeoutMs: 8_000 });
        expect(result.outcome).toBe('ok');
        expect(result.era).toBe('legacy');
        expect(result.tools).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(result.serverInfo?.name).toBe('fake-mcp');
        expect(server.state.methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/list']);
        expect(server.state.deletes).toBe(1);
        expect(JSON.stringify(result.steps)).not.toContain('secret-token-123');
      } finally {
        await server.close();
      }
    }
  });

  it('maps 401, 404 and timeouts', async () => {
    const { probeMcpServer } = await import('./probe');
    const server = await startFakeMcp({ expectedAuthorization: 'Bearer good', tools: ['x'] });
    try {
      const unauthorized = await probeMcpServer({ url: server.url, headers: { Authorization: 'Bearer bad' } });
      expect(unauthorized.outcome).toBe('unauthorized');
      expect(unauthorized.steps[0]?.headers?.['www-authenticate']).toContain('resource_metadata=');
      server.state.forceStatus = 404;
      expect((await probeMcpServer({ url: server.url, headers: { Authorization: 'Bearer good' } })).outcome).toBe('not_found');
      server.state.forceStatus = null;
      server.state.delayMs = 1_500;
      expect((await probeMcpServer({ url: server.url, headers: { Authorization: 'Bearer good' }, timeoutMs: 300 })).outcome).toBe('timeout');
    } finally {
      await server.close();
    }
  });
});

describe('registry and per-session configuration', () => {
  it('seeds the four built-in servers, disabled until a project enables them', async () => {
    const { listMcpServers } = await import('./registry');
    const servers = await listMcpServers({ spaceId: S });
    expect(servers.map((server) => server.name)).toEqual(['figma', 'github', 'coolify', 'playwright']);
    expect(servers.every((server) => server.displayStatus === 'disabled' && server.action.kind === 'activate')).toBe(true);
    expect(servers.find((server) => server.name === 'figma')?.badge.label).toBe('Désactivé');
  });

  it('builds a --mcp-config with only the project servers, no secret, and the deny rules', async () => {
    const { setProjectMcpServer, createMcpServer } = await import('./registry');
    const { buildSessionMcpConfig } = await import('./session-config');
    const project = await createProject();
    const other = await createProject('Atelier Lune', 'nuera-studio/atelier-lune');
    await createMcpServer(S, { name: 'linear', label: 'Linear', transport: 'http', url: 'https://mcp.linear.example/mcp', authKind: 'bearer', bearerToken: 'lin_secret_value_0123456789' });
    for (const name of ['figma', 'playwright', 'coolify', 'linear']) {
      await setProjectMcpServer({ projectId: project.id, serverIdOrName: name, enabled: true }, { actorUserId: TEST_USER_ID });
    }
    await setProjectMcpServer({ projectId: other.id, serverIdOrName: 'github', enabled: true });

    const config = await buildSessionMcpConfig(project.id);
    expect(Object.keys(config.mcpConfig.mcpServers).sort()).toEqual(['figma', 'linear', 'playwright']);
    expect(config.mcpConfig.mcpServers.figma).toEqual({ type: 'http', url: 'https://mcp.figma.com/mcp' });
    expect(config.mcpConfig.mcpServers.linear).toEqual({ type: 'http', url: 'https://mcp.linear.example/mcp', headersHelper: 'nuera' });
    expect(config.mcpConfig.mcpServers.playwright).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@0.0.84', '--headless', '--isolated'] });
    expect(config.skipped).toEqual([{ name: 'coolify', reason: "Coolify n'est pas connecté." }]);
    expect(config.denyRules).toContain('mcp__figma__use_figma');
    expect(config.denyRules).not.toContain('mcp__coolify__deploy'); // coolify left out of this session
    expect(config.env).toEqual({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
    expect(JSON.stringify(config)).not.toMatch(/lin_secret|Bearer/);

    const otherConfig = await buildSessionMcpConfig(other.id);
    expect(Object.keys(otherConfig.mcpConfig.mcpServers)).toEqual([]);
    expect(otherConfig.skipped).toEqual([{ name: 'github', reason: "GitHub n'est pas connecté." }]);
  });

  it('derives « Dernier appel » from the tool events of the hook bridge', async () => {
    const { db } = await import('@/server/db');
    const { getMcpServer } = await import('./registry');
    const project = await createProject();
    const [session] = await db.insert(sessions).values({ id: crypto.randomUUID(), projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, title: 'Module CRM', status: 'running' }).returning();
    const tool = (position: number, name: string, at: string, status = 'done') => ({
      sessionId: session!.id,
      position,
      version: position,
      kind: 'tool' as const,
      payload: { tool: name, status, startedAt: at, finishedAt: at },
      createdAt: new Date(at),
      updatedAt: new Date(at),
    });
    await db.insert(sessionEvents).values([
      tool(1, 'mcp__figma__get_metadata', '2026-11-05T08:00:00Z'),
      tool(2, 'mcp__figma__get_design_context', '2026-11-05T09:00:00Z', 'error'),
      tool(3, 'Bash', '2026-11-05T10:00:00Z'),
    ]);
    const figma = await getMcpServer(ref('figma'));
    expect(figma.lastCall).toEqual({
      at: '2026-11-05T09:00:00.000Z',
      tool: 'mcp__figma__get_design_context',
      projectId: project.id,
      projectName: 'Nuera OS',
      ok: false,
    });
    expect((await getMcpServer(ref('github'))).lastCall).toBeNull();
  });

  it('stores custom headers encrypted and only exposes their names', async () => {
    const { createMcpServer, getMcpServer } = await import('./registry');
    const view = await createMcpServer(S, { name: 'sentry', label: 'Sentry', transport: 'http', url: 'https://mcp.sentry.example/mcp', authKind: 'header', headers: { 'X-Api-Key': 'sentry_secret_0123456789' } });
    expect(view.secretKeys).toEqual(['X-Api-Key']);
    expect(JSON.stringify(await getMcpServer(ref('sentry')))).not.toContain('sentry_secret');
    expect(await dumpIntegrationTables()).not.toContain('sentry_secret');
    await expect(createMcpServer(S, { name: 'figma', label: 'x', transport: 'http', url: 'https://x.example/mcp' })).rejects.toThrow();
  });
});

describe('mcp_servers.config (non-secret headers, denied tools, preset)', () => {
  it('sends the stored static headers and denied tools to the session and shows them in the drawer', async () => {
    const { createMcpServer, updateMcpServer, getMcpServer, setProjectMcpServer, listMcpServers } = await import('./registry');
    const { buildSessionMcpConfig } = await import('./session-config');
    const { db } = await import('@/server/db');
    const project = await createProject();
    const view = await createMcpServer(S, {
      name: 'linear',
      label: 'Linear',
      transport: 'http',
      url: 'https://mcp.linear.example/mcp',
      staticHeaders: { 'X-Workspace': 'nuera' },
      denyTools: ['delete_issue'],
    });
    expect(view.denyRules).toEqual(['mcp__linear__delete_issue']);
    expect(view.configurationLines).toEqual(expect.arrayContaining(['en-têtes fixes : X-Workspace', 'outils refusés à Claude : delete_issue']));
    await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'linear', enabled: true });
    // Narrowing a preset is allowed; its own headers stay (GitHub read-only), new ones are refused.
    await updateMcpServer(ref('figma'), { denyTools: ['get_screenshot'] });
    await expect(updateMcpServer(ref('github'), { staticHeaders: { 'X-MCP-Readonly': 'false' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'figma', enabled: true });

    const config = await buildSessionMcpConfig(project.id);
    expect(config.mcpConfig.mcpServers.linear).toEqual({ type: 'http', url: 'https://mcp.linear.example/mcp', headers: { 'X-Workspace': 'nuera' } });
    expect(config.denyRules).toEqual(expect.arrayContaining(['mcp__linear__delete_issue', 'mcp__figma__get_screenshot', 'mcp__figma__use_figma']));

    // Credential headers never go to the clear config; clearing works.
    await expect(updateMcpServer(ref('linear'), { staticHeaders: { Authorization: 'Bearer x' } })).rejects.toThrow();
    await updateMcpServer(ref('linear'), { staticHeaders: null, denyTools: null });
    expect((await getMcpServer(ref('linear'))).denyRules).toEqual([]);
    expect((await buildSessionMcpConfig(project.id)).mcpConfig.mcpServers.linear).toEqual({ type: 'http', url: 'https://mcp.linear.example/mcp' });

    // Seeded presets record their preset id.
    await listMcpServers({ spaceId: S });
    const rows = await db.select({ name: mcpServers.name, config: mcpServers.config }).from(mcpServers);
    expect(rows.find((row) => row.name === 'coolify')?.config).toMatchObject({ presetId: 'coolify' });
  });
});

describe('diagnostics', () => {
  it('checks an HTTP server with its stored credential, then reports « Autorisation expirée » on 401', async () => {
    const server = await startFakeMcp({ expectedAuthorization: 'Bearer lin_token_0123456789', tools: ['list_issues', 'get_issue'] });
    try {
      const { createMcpServer, setProjectMcpServer } = await import('./registry');
      const { checkMcpServer } = await import('./diagnostics');
      const project = await createProject();
      await createMcpServer(S, { name: 'linear', label: 'Linear', transport: 'http', url: server.url, authKind: 'bearer', bearerToken: 'lin_token_0123456789' });
      await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'linear', enabled: true });
      const ok = await checkMcpServer(ref('linear'), { trigger: 'schedule' });
      expect(ok.status).toBe('connected');
      expect(ok.toolCount).toBe(2);
      expect(ok.badge.label).toBe('Connecté');

      server.state.expectedAuthorization = 'Bearer rotated';
      const expired = await checkMcpServer(ref('linear'), { trigger: 'schedule' });
      expect(expired.status).toBe('expired');
      expect(expired.badge.label).toBe('Autorisation expirée');
      expect(expired.action).toEqual({ kind: 'reconnect', label: 'Reconnecter', via: 'headers' });
      const { db } = await import('@/server/db');
      const rows = await db.select().from(notifications);
      expect(rows.map((row) => row.title)).toEqual(["L'accès Linear a été retiré"]);
      expect(JSON.stringify(expired)).not.toContain('lin_token');
    } finally {
      await server.close();
    }
  });

  it('runs the manual test right after a failed one when the secret has just been replaced', async () => {
    const server = await startFakeMcp({ expectedAuthorization: 'Bearer lin_token_0123456789', tools: ['list_issues'] });
    try {
      const { createMcpServer, setProjectMcpServer, updateMcpServer } = await import('./registry');
      const { checkMcpServer } = await import('./diagnostics');
      const project = await createProject();
      await createMcpServer(S, { name: 'linear', label: 'Linear', transport: 'http', url: server.url, authKind: 'bearer', bearerToken: 'lin_token_0123456789' });
      await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'linear', enabled: true });
      expect((await checkMcpServer(ref('linear'))).status).toBe('connected');
      server.state.expectedAuthorization = 'Bearer lin_rotated_0123456789';
      // Within 10 s of the previous manual test: the same credential is not re-tested…
      expect((await checkMcpServer(ref('linear'))).status).toBe('connected');
      // …but a replaced secret is (otherwise « Reconnecter » would keep the stale state).
      await updateMcpServer(ref('linear'), { bearerToken: 'lin_rotated_0123456789' });
      expect((await checkMcpServer(ref('linear'))).status).toBe('connected');
      expect(server.state.receivedHeaders.at(-1)?.authorization).toBe('Bearer lin_rotated_0123456789');
    } finally {
      await server.close();
    }
  });

  it('reads OAuth and stdio servers through `claude mcp get` (runner), syncing the user scope first', async () => {
    const reach = await startFakeMcp({ expectedAuthorization: 'Bearer oauth-only', tools: [] });
    try {
      const { db } = await import('@/server/db');
      const { ensurePresetServers, setProjectMcpServer } = await import('./registry');
      const { checkMcpServer, startMcpLogin } = await import('./diagnostics');
      await ensurePresetServers(S);
      await db.update(mcpServers).set({ url: reach.url }).where(eq(mcpServers.name, 'figma'));
      const project = await createProject();
      await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'figma', enabled: true });
      await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'playwright', enabled: true });

      const port = fakePort({ playwright: 'connected' });
      const figma = await checkMcpServer(ref('figma'), { trigger: 'schedule', port });
      expect(port.synced).toContain('figma');
      expect(figma.status).toBe('needs_auth');
      expect(figma.badge.label).toBe('Connexion requise');
      expect(figma.lastCheck?.steps[0]?.httpStatus).toBe(401);
      // Never authorised: nothing was « retiré », no T7 notification is pushed.
      expect(await db.select().from(notifications)).toHaveLength(0);
      expect((await checkMcpServer(ref('playwright'), { trigger: 'schedule', port })).status).toBe('connected');

      const login = await startMcpLogin(testContext(), 'figma', { port });
      expect(port.logins).toEqual(['figma']);
      expect(login.streamUrl).toBe('/api/stream/terminals/term_abcdefgh12');
      await expect(startMcpLogin(testContext(), 'playwright', { port })).rejects.toMatchObject({ code: 'VALIDATION' });
    } finally {
      await reach.close();
    }
  });

  it('maps the CLI states', async () => {
    const { statusFromCli } = await import('./diagnostics');
    expect(statusFromCli({ state: 'connected' }, 'unknown').status).toBe('connected');
    expect(statusFromCli({ state: 'needs_auth' }, 'connected').status).toBe('expired');
    expect(statusFromCli({ state: 'needs_auth' }, 'unknown').status).toBe('needs_auth');
    expect(statusFromCli({ state: 'failed' }, 'connected')).toMatchObject({ status: 'error', transient: true });
    expect(statusFromCli({ state: 'disabled' }, 'connected').status).toBe('disabled');
  });
});

describe('GitHub MCP and the fallback PAT', () => {
  it('never hands GITHUB_FALLBACK_TOKEN to Claude (not read-only, not limited to one repository)', async () => {
    const pat = 'github_pat_fallback_0123456789abcdefghijklmn';
    process.env.GITHUB_FALLBACK_TOKEN = pat;
    try {
      const { db } = await import('@/server/db');
      const { setProjectMcpServer } = await import('./registry');
      const { buildSessionMcpConfig } = await import('./session-config');
      const { GITHUB_MCP_APP_REQUIRED, resolveSessionMcpHeaders } = await import('./headers');
      const { checkMcpServer } = await import('./diagnostics');
      const project = await createProject();
      await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'github', enabled: true });
      const [session] = await db.insert(sessions).values({ id: crypto.randomUUID(), projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, title: 'Module CRM', status: 'running' }).returning();

      const config = await buildSessionMcpConfig(project.id);
      expect(config.mcpConfig.mcpServers.github).toBeUndefined();
      expect(config.skipped).toEqual([{ name: 'github', reason: GITHUB_MCP_APP_REQUIRED }]);
      await expect(resolveSessionMcpHeaders({ sessionId: session!.id, serverName: 'github', environmentId: TEST_ENVIRONMENT_ID })).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const checked = await checkMcpServer(ref('github'), { trigger: 'schedule' });
      expect(checked.status).toBe('needs_auth');
      expect(checked.lastError).toBe(GITHUB_MCP_APP_REQUIRED);
      expect(JSON.stringify(checked)).not.toContain(pat);
      expect(await dumpIntegrationTables()).not.toContain(pat);
    } finally {
      delete process.env.GITHUB_FALLBACK_TOKEN;
    }
  });
});

describe('session headers (internal endpoint)', () => {
  it('serves headers only to a live session whose project enables the server', async () => {
    const { db } = await import('@/server/db');
    const { createMcpServer, setProjectMcpServer } = await import('./registry');
    const { resolveSessionMcpHeaders } = await import('./headers');
    const project = await createProject();
    await createMcpServer(S, { name: 'linear', label: 'Linear', transport: 'http', url: 'https://mcp.linear.example/mcp', authKind: 'bearer', bearerToken: 'lin_token_session_0123' });
    const [session] = await db.insert(sessions).values({ id: crypto.randomUUID(), projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, title: 'Module CRM', status: 'running' }).returning();

    await expect(resolveSessionMcpHeaders({ sessionId: session!.id, serverName: 'linear', environmentId: TEST_ENVIRONMENT_ID })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'linear', enabled: true });
    expect(await resolveSessionMcpHeaders({ sessionId: session!.id, serverName: 'linear', environmentId: TEST_ENVIRONMENT_ID })).toEqual({
      headers: { Authorization: 'Bearer lin_token_session_0123' },
      expiresAt: null,
    });
    await db.update(sessions).set({ status: 'stopped' }).where(eq(sessions.id, session!.id));
    await expect(resolveSessionMcpHeaders({ sessionId: session!.id, serverName: 'linear', environmentId: TEST_ENVIRONMENT_ID })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(resolveSessionMcpHeaders({ sessionId: crypto.randomUUID(), serverName: 'linear', environmentId: TEST_ENVIRONMENT_ID })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await db.update(sessions).set({ status: 'waiting_input' }).where(eq(sessions.id, session!.id));
    await db.update(projectMcpServers).set({ enabled: false });
    await expect(resolveSessionMcpHeaders({ sessionId: session!.id, serverName: 'linear', environmentId: TEST_ENVIRONMENT_ID })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('one registry per space', () => {
  it('lets two spaces use the same custom name and never shows one space to the other', async () => {
    const { db } = await import('@/server/db');
    const { createMcpServer, getMcpServer, listMcpServers, setProjectMcpServer } = await import('./registry');
    const b = await otherSpace();
    const projectA = await createProject();
    const projectB = await createProject('Projet B', 'camille/projet-b', { spaceId: b.space.id, environmentId: b.environment!.id });
    const linearA = await createMcpServer(S, { name: 'linear', label: 'Linear A', transport: 'http', url: 'https://mcp.linear.example/mcp', authKind: 'bearer', bearerToken: 'lin_a_secret_0123456789' });
    const linearB = await createMcpServer(b.space.id, { name: 'linear', label: 'Linear B', transport: 'http', url: 'https://mcp.linear.example/mcp', authKind: 'bearer', bearerToken: 'lin_b_secret_0123456789' });
    expect(linearA.id).not.toBe(linearB.id);
    await expect(createMcpServer(S, { name: 'linear', label: 'x', transport: 'http', url: 'https://x.example/mcp' })).rejects.toThrow(/existe déjà dans votre espace/);

    await setProjectMcpServer({ spaceId: S, projectId: projectA.id, serverIdOrName: 'linear', enabled: true });
    // A project of B with A's server, or A's project from B: the « unknown » answers, nothing written.
    const unknownProject = await setProjectMcpServer({ spaceId: b.space.id, projectId: crypto.randomUUID(), serverIdOrName: 'linear', enabled: true }).catch((error: unknown) => error);
    const foreignProject = await setProjectMcpServer({ spaceId: b.space.id, projectId: projectA.id, serverIdOrName: 'linear', enabled: true }).catch((error: unknown) => error);
    expect(foreignProject).toEqual(unknownProject);
    expect(foreignProject).toMatchObject({ code: 'NOT_FOUND', message: 'Projet introuvable.' });
    const unknownServer = await getMcpServer({ spaceId: b.space.id, idOrName: crypto.randomUUID() }).catch((error: unknown) => error);
    const foreignServer = await getMcpServer({ spaceId: b.space.id, idOrName: linearA.id }).catch((error: unknown) => error);
    expect(foreignServer).toEqual(unknownServer);
    expect(foreignServer).toMatchObject({ code: 'NOT_FOUND', message: 'Serveur MCP introuvable.' });
    const activations = await db.select().from(projectMcpServers);
    expect(activations).toHaveLength(1);

    // « ACTIVÉ DANS » lists the projects of the space only.
    const listedB = await listMcpServers({ spaceId: b.space.id });
    expect(listedB.find((server) => server.name === 'linear')).toMatchObject({ label: 'Linear B', projectCount: 0 });
    expect(listedB.flatMap((server) => server.projects.map((project) => project.id))).not.toContain(projectA.id);
    expect(listedB.flatMap((server) => server.projects.map((project) => project.id))).toContain(projectB.id);
    const listedA = await listMcpServers({ spaceId: S });
    expect(listedA.find((server) => server.name === 'linear')).toMatchObject({ label: 'Linear A', projectCount: 1 });
    expect(listedA.flatMap((server) => server.projects.map((project) => project.id))).not.toContain(projectB.id);
    // Every built-in server exists in each registry (ensured on read).
    expect(listedB.filter((server) => server.preset).map((server) => server.name)).toEqual(['figma', 'github', 'coolify', 'playwright']);
  });

  it('shows « Dernier appel » of the projects of the space only', async () => {
    const { db } = await import('@/server/db');
    const { getMcpServer } = await import('./registry');
    const b = await otherSpace();
    const projectB = await createProject('Projet B', 'camille/projet-b', { spaceId: b.space.id, environmentId: b.environment!.id });
    const [sessionB] = await db.insert(sessions).values({ id: crypto.randomUUID(), projectId: projectB.id, environmentId: b.environment!.id, title: 'B', status: 'running' }).returning();
    await db.insert(sessionEvents).values({ sessionId: sessionB!.id, position: 1, version: 1, kind: 'tool', payload: { tool: 'mcp__figma__get_metadata', status: 'done' } });
    expect((await getMcpServer(ref('figma'))).lastCall).toBeNull();
    expect((await getMcpServer({ spaceId: b.space.id, idOrName: 'figma' })).lastCall?.projectId).toBe(projectB.id);
  });

  it('writes the preset copy for the server of the space (« chiffré par Nuera Dev » outside the default one)', async () => {
    const { db } = await import('@/server/db');
    const { getMcpServer, listMcpServers } = await import('./registry');
    const own = await getMcpServer(ref('playwright'), { server: { name: 'VPS-3', isDefault: true } });
    expect(own.subtitle).toBe('Serveur MCP · navigateur de test sur VPS-3');
    expect(own.scopeNote).toBe('Navigateur sans interface lancé sur VPS-3, profil effacé à chaque session.');
    const coolify = await getMcpServer(ref('coolify'), { server: { name: 'VPS-3', isDefault: true } });
    expect(coolify.configurationLines).toContain('authentification : jeton Coolify chiffré sur VPS-3');
    const other = await getMcpServer(ref('coolify'), { server: { name: 'VPS-4', isDefault: false } });
    expect(other.configurationLines).toContain('authentification : jeton Coolify chiffré par Nuera Dev');
    const playwright = await getMcpServer(ref('playwright'), { server: { name: 'VPS-4', isDefault: false } });
    expect(playwright.subtitle).toBe('Serveur MCP · navigateur de test sur VPS-4');
    // A scope note written before servers had names is rewritten; one changed by the owner is kept.
    await db.update(mcpServers).set({ scopeNote: 'Navigateur sans interface lancé sur VPS-3, profil effacé à chaque session.' }).where(eq(mcpServers.name, 'playwright'));
    expect((await getMcpServer(ref('playwright'), { server: { name: 'VPS-4', isDefault: false } })).scopeNote).toBe('Navigateur sans interface lancé sur VPS-4, profil effacé à chaque session.');
    await db.update(mcpServers).set({ scopeNote: 'Mon navigateur.' }).where(eq(mcpServers.name, 'playwright'));
    expect((await listMcpServers({ spaceId: S, server: null })).find((server) => server.name === 'playwright')?.scopeNote).toBe('Mon navigateur.');
  });

  it('refuses an internal MCP address (SSRF guard) unless allow-listed', async () => {
    const { createMcpServer } = await import('./registry');
    delete process.env.NUERA_PRIVATE_HOSTS;
    try {
      await expect(createMcpServer(S, { name: 'local', label: 'Local', transport: 'http', url: 'http://127.0.0.1:8080/mcp' })).rejects.toMatchObject({
        code: 'VALIDATION',
        message: expect.stringMatching(/^Adresse refusée/),
      });
    } finally {
      allowLocalFakes();
    }
    await expect(createMcpServer(S, { name: 'local', label: 'Local', transport: 'http', url: 'http://127.0.0.1:8080/mcp' })).resolves.toMatchObject({ name: 'local' });
  });
});

describe('Claude Code state of the space server', () => {
  it('keeps CLI-diagnosed servers « à tester » without a server, and refuses the login (409)', async () => {
    const { db } = await import('@/server/db');
    const { setProjectMcpServer } = await import('./registry');
    const { checkMcpServer, NO_SERVER_MESSAGE, startMcpLogin } = await import('./diagnostics');
    const b = await otherSpace(false);
    const projectA = await createProject();
    await setProjectMcpServer({ projectId: projectA.id, serverIdOrName: 'playwright', enabled: true });
    const checked = await checkMcpServer({ spaceId: b.space.id, idOrName: 'playwright' }, { trigger: 'schedule' });
    expect(checked).toMatchObject({ status: 'unknown', lastError: NO_SERVER_MESSAGE });
    await expect(startMcpLogin(b.ctx, 'figma')).rejects.toMatchObject({ code: 'CONFLICT', reason: 'NO_ENVIRONMENT', message: NO_SERVER_MESSAGE });
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it('opens the OAuth login terminal for the owner of the space only, on an active server', async () => {
    const { db } = await import('@/server/db');
    const { auditLog } = await import('@nuera/db/schema');
    const { ensurePresetServers } = await import('./registry');
    const { MCP_LOGIN_OWNER_ONLY, SERVER_DISABLED_MESSAGE, startMcpLogin } = await import('./diagnostics');
    await ensurePresetServers(S);
    const owner = testContext();
    const refusals: Array<[string, typeof owner, Record<string, unknown>]> = [
      ['member of the space', { ...owner, space: { ...owner.space, role: 'member' } }, { code: 'FORBIDDEN', message: MCP_LOGIN_OWNER_ONLY, untouched: 'Aucun terminal ouvert.' }],
      ['suspended server', { ...owner, environment: { ...owner.environment!, status: 'suspended' } }, { code: 'FORBIDDEN', reason: 'ENVIRONMENT_DISABLED', message: SERVER_DISABLED_MESSAGE }],
      ['retired server', { ...owner, environment: { ...owner.environment!, status: 'retired' } }, { code: 'FORBIDDEN', reason: 'ENVIRONMENT_DISABLED', message: SERVER_DISABLED_MESSAGE }],
      ['no server', { ...owner, environment: null }, { code: 'CONFLICT', reason: 'NO_ENVIRONMENT' }],
    ];
    const port = fakePort({});
    for (const [name, ctx, error] of refusals) {
      // Refused before anything is read or sent: the same answer for an unknown server name.
      await expect(startMcpLogin(ctx, 'figma', { port }), name).rejects.toMatchObject(error);
      await expect(startMcpLogin(ctx, 'inconnu', { port }), name).rejects.toMatchObject(error);
    }
    expect(port.synced).toEqual([]);
    expect(port.logins).toEqual([]);
    expect(await db.select().from(auditLog)).toHaveLength(0);

    // The owner: synced then opened on its server, audited in its space with the server.
    await startMcpLogin(owner, 'figma', { port });
    expect(port.synced).toEqual(['figma']);
    expect(port.logins).toEqual(['figma']);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'integration.mcp.login_started'));
    expect(entry).toMatchObject({ spaceId: S, environmentId: TEST_ENVIRONMENT_ID, actorUserId: TEST_USER_ID, actorKind: 'user', targetType: 'mcp_server' });
  });

  it('refuses a server of another space exactly like an unknown one, without calling the runner', async () => {
    const { db } = await import('@/server/db');
    const { createMcpServer, ensurePresetServers } = await import('./registry');
    const { startMcpLogin } = await import('./diagnostics');
    await ensurePresetServers(S);
    const b = await otherSpace();
    const foreign = await createMcpServer(b.space.id, { name: 'oauth-b', label: 'OAuth B', transport: 'http', url: 'https://mcp.oauth-b.example/mcp', authKind: 'oauth' });
    const port = fakePort({});
    const before = await dumpIntegrationTables();
    const unknown = await startMcpLogin(testContext(), crypto.randomUUID(), { port }).catch((error: unknown) => error);
    for (const idOrName of [foreign.id, 'oauth-b']) {
      const error = await startMcpLogin(testContext(), idOrName, { port }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'NOT_FOUND' });
      expect((error as Error).message).toBe((unknown as Error).message);
    }
    expect(port.synced).toEqual([]);
    expect(port.logins).toEqual([]);
    expect(await dumpIntegrationTables()).toBe(before);
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it('keeps the copy of the other login terminals', async () => {
    const { MCP_LOGIN_OWNER_ONLY, NO_SERVER_MESSAGE } = await import('./diagnostics');
    const { LOGIN_TERMINAL_OWNER_ONLY } = await import('@/server/terminals');
    const { NO_ENVIRONMENT_MESSAGE } = await import('@/server/tenancy/context');
    expect(MCP_LOGIN_OWNER_ONLY).toBe(LOGIN_TERMINAL_OWNER_ONLY);
    expect(NO_SERVER_MESSAGE).toBe(NO_ENVIRONMENT_MESSAGE);
  });

  it('syncs to the CLI and marks only the rows of the space; resets its CLI state', async () => {
    const { db } = await import('@/server/db');
    const { getMcpServerRow } = await import('./registry');
    const { resetCliMcpState, syncMcpServersToCli } = await import('./diagnostics');
    const b = await otherSpace();
    const rowB = (await getMcpServerRow({ spaceId: b.space.id, idOrName: 'playwright' }))!;
    const rowA = (await getMcpServerRow(ref('playwright')))!;
    const port = fakePort({});
    // A row of B handed to A's sync is ignored.
    expect(await syncMcpServersToCli({ spaceId: S, upsert: [rowB] }, port)).toEqual({ ok: true, results: [], error: null });
    await syncMcpServersToCli({ spaceId: S, upsert: [rowA] }, port);
    const synced = await db.select({ spaceId: mcpServers.spaceId }).from(mcpServers).where(and(eq(mcpServers.name, 'playwright')));
    const marked = await db.select().from(mcpServers).where(eq(mcpServers.name, 'playwright'));
    expect(marked.filter((row) => row.syncedToCliAt).map((row) => row.spaceId)).toEqual([S]);
    expect(synced).toHaveLength(2);
    await db.update(mcpServers).set({ status: 'connected' }).where(eq(mcpServers.name, 'playwright'));
    expect(await resetCliMcpState(S)).toBeGreaterThan(0);
    const after = await db.select().from(mcpServers).where(eq(mcpServers.name, 'playwright'));
    expect(after.find((row) => row.spaceId === S)).toMatchObject({ status: 'unknown', syncedToCliAt: null });
    expect(after.find((row) => row.spaceId === b.space.id)?.status).toBe('connected');
  });
});

describe('session headers: server and URL pinned', () => {
  it("refuses another server's session and an unexpected URL", async () => {
    const { db } = await import('@/server/db');
    const { createMcpServer, setProjectMcpServer } = await import('./registry');
    const { resolveSessionMcpHeaders, UNEXPECTED_MCP_URL } = await import('./headers');
    const b = await otherSpace();
    const project = await createProject();
    await createMcpServer(S, { name: 'linear', label: 'Linear', transport: 'http', url: 'https://mcp.linear.example/mcp', authKind: 'bearer', bearerToken: 'lin_token_pinned_0123' });
    await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'linear', enabled: true });
    const [session] = await db.insert(sessions).values({ id: crypto.randomUUID(), projectId: project.id, environmentId: TEST_ENVIRONMENT_ID, title: 'Module CRM', status: 'running' }).returning();
    const base = { sessionId: session!.id, serverName: 'linear' };
    await expect(resolveSessionMcpHeaders({ ...base, environmentId: b.environment!.id })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Session inconnue.' });
    await expect(resolveSessionMcpHeaders({ ...base, environmentId: TEST_ENVIRONMENT_ID, projectId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(resolveSessionMcpHeaders({ ...base, environmentId: TEST_ENVIRONMENT_ID, serverUrl: 'https://evil.example/mcp' })).rejects.toMatchObject({ code: 'FORBIDDEN', message: UNEXPECTED_MCP_URL });
    expect(await resolveSessionMcpHeaders({ ...base, environmentId: TEST_ENVIRONMENT_ID, serverUrl: 'https://MCP.linear.example/mcp/' })).toEqual({
      headers: { Authorization: 'Bearer lin_token_pinned_0123' },
      expiresAt: null,
    });
    // The same name in B's registry is never served for A's session.
    await createMcpServer(b.space.id, { name: 'other', label: 'Other', transport: 'http', url: 'https://other.example/mcp', authKind: 'bearer', bearerToken: 'other_token_0123456789' });
    await expect(resolveSessionMcpHeaders({ sessionId: session!.id, serverName: 'other', environmentId: TEST_ENVIRONMENT_ID })).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Serveur MCP désactivé.' });
  });
});
