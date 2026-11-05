import { mcpServers, notifications, projectMcpServers, projects, sessionEvents, sessions } from '@nuera/db/schema';
import type { McpCliStatus, TerminalDto } from '@nuera/shared/runner';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, dumpIntegrationTables, prepareTestDatabase, resetTables, TEST_USER_ID, useTestEncryptionKey } from '@/server/integrations/test/db';
import type { McpRunnerPort } from './diagnostics';
import { startFakeMcp } from './test/fake-mcp';

beforeAll(async () => {
  await prepareTestDatabase('mcp');
  useTestEncryptionKey();
  process.env.APP_URL = 'http://localhost:3104';
  delete process.env.GITHUB_FALLBACK_TOKEN;
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTables();
  (globalThis as { __nueraMcpLastManual?: Map<string, number> }).__nueraMcpLastManual = new Map();
});

async function createProject(name = 'Nuera OS', fullName = 'nuera-studio/nuera-os') {
  const { db } = await import('@/server/db');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const [project] = await db
    .insert(projects)
    .values({ slug, name, githubFullName: fullName, cloneUrl: `https://github.com/${fullName}.git`, path: `/srv/dev/${slug}`, status: 'ready' })
    .returning();
  return project!;
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
    const servers = await listMcpServers();
    expect(servers.map((server) => server.name)).toEqual(['figma', 'github', 'coolify', 'playwright']);
    expect(servers.every((server) => server.displayStatus === 'disabled' && server.action.kind === 'activate')).toBe(true);
    expect(servers.find((server) => server.name === 'figma')?.badge.label).toBe('Désactivé');
  });

  it('builds a --mcp-config with only the project servers, no secret, and the deny rules', async () => {
    const { setProjectMcpServer, createMcpServer } = await import('./registry');
    const { buildSessionMcpConfig } = await import('./session-config');
    const project = await createProject();
    const other = await createProject('Atelier Lune', 'nuera-studio/atelier-lune');
    await createMcpServer({ name: 'linear', label: 'Linear', transport: 'http', url: 'https://mcp.linear.example/mcp', authKind: 'bearer', bearerToken: 'lin_secret_value_0123456789' });
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
    const [session] = await db.insert(sessions).values({ id: crypto.randomUUID(), projectId: project.id, title: 'Module CRM', status: 'running' }).returning();
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
    const figma = await getMcpServer('figma');
    expect(figma.lastCall).toEqual({
      at: '2026-11-05T09:00:00.000Z',
      tool: 'mcp__figma__get_design_context',
      projectId: project.id,
      projectName: 'Nuera OS',
      ok: false,
    });
    expect((await getMcpServer('github')).lastCall).toBeNull();
  });

  it('stores custom headers encrypted and only exposes their names', async () => {
    const { createMcpServer, getMcpServer } = await import('./registry');
    const view = await createMcpServer({ name: 'sentry', label: 'Sentry', transport: 'http', url: 'https://mcp.sentry.example/mcp', authKind: 'header', headers: { 'X-Api-Key': 'sentry_secret_0123456789' } });
    expect(view.secretKeys).toEqual(['X-Api-Key']);
    expect(JSON.stringify(await getMcpServer('sentry'))).not.toContain('sentry_secret');
    expect(await dumpIntegrationTables()).not.toContain('sentry_secret');
    await expect(createMcpServer({ name: 'figma', label: 'x', transport: 'http', url: 'https://x.example/mcp' })).rejects.toThrow();
  });
});

describe('mcp_servers.config (non-secret headers, denied tools, preset)', () => {
  it('sends the stored static headers and denied tools to the session and shows them in the drawer', async () => {
    const { createMcpServer, updateMcpServer, getMcpServer, setProjectMcpServer, listMcpServers } = await import('./registry');
    const { buildSessionMcpConfig } = await import('./session-config');
    const { db } = await import('@/server/db');
    const project = await createProject();
    const view = await createMcpServer({
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
    await updateMcpServer('figma', { denyTools: ['get_screenshot'] });
    await expect(updateMcpServer('github', { staticHeaders: { 'X-MCP-Readonly': 'false' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'figma', enabled: true });

    const config = await buildSessionMcpConfig(project.id);
    expect(config.mcpConfig.mcpServers.linear).toEqual({ type: 'http', url: 'https://mcp.linear.example/mcp', headers: { 'X-Workspace': 'nuera' } });
    expect(config.denyRules).toEqual(expect.arrayContaining(['mcp__linear__delete_issue', 'mcp__figma__get_screenshot', 'mcp__figma__use_figma']));

    // Credential headers never go to the clear config; clearing works.
    await expect(updateMcpServer('linear', { staticHeaders: { Authorization: 'Bearer x' } })).rejects.toThrow();
    await updateMcpServer('linear', { staticHeaders: null, denyTools: null });
    expect((await getMcpServer('linear')).denyRules).toEqual([]);
    expect((await buildSessionMcpConfig(project.id)).mcpConfig.mcpServers.linear).toEqual({ type: 'http', url: 'https://mcp.linear.example/mcp' });

    // Seeded presets record their preset id.
    await listMcpServers();
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
      await createMcpServer({ name: 'linear', label: 'Linear', transport: 'http', url: server.url, authKind: 'bearer', bearerToken: 'lin_token_0123456789' });
      await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'linear', enabled: true });
      const ok = await checkMcpServer('linear', { trigger: 'schedule' });
      expect(ok.status).toBe('connected');
      expect(ok.toolCount).toBe(2);
      expect(ok.badge.label).toBe('Connecté');

      server.state.expectedAuthorization = 'Bearer rotated';
      const expired = await checkMcpServer('linear', { trigger: 'schedule' });
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
      await createMcpServer({ name: 'linear', label: 'Linear', transport: 'http', url: server.url, authKind: 'bearer', bearerToken: 'lin_token_0123456789' });
      await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'linear', enabled: true });
      expect((await checkMcpServer('linear')).status).toBe('connected');
      server.state.expectedAuthorization = 'Bearer lin_rotated_0123456789';
      // Within 10 s of the previous manual test: the same credential is not re-tested…
      expect((await checkMcpServer('linear')).status).toBe('connected');
      // …but a replaced secret is (otherwise « Reconnecter » would keep the stale state).
      await updateMcpServer('linear', { bearerToken: 'lin_rotated_0123456789' });
      expect((await checkMcpServer('linear')).status).toBe('connected');
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
      await ensurePresetServers();
      await db.update(mcpServers).set({ url: reach.url }).where(eq(mcpServers.name, 'figma'));
      const project = await createProject();
      await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'figma', enabled: true });
      await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'playwright', enabled: true });

      const port = fakePort({ playwright: 'connected' });
      const figma = await checkMcpServer('figma', { trigger: 'schedule', port });
      expect(port.synced).toContain('figma');
      expect(figma.status).toBe('needs_auth');
      expect(figma.badge.label).toBe('Connexion requise');
      expect(figma.lastCheck?.steps[0]?.httpStatus).toBe(401);
      // Never authorised: nothing was « retiré », no T7 notification is pushed.
      expect(await db.select().from(notifications)).toHaveLength(0);
      expect((await checkMcpServer('playwright', { trigger: 'schedule', port })).status).toBe('connected');

      const login = await startMcpLogin('figma', { actorUserId: TEST_USER_ID, port });
      expect(port.logins).toEqual(['figma']);
      expect(login.streamUrl).toBe('/api/stream/terminals/term_abcdefgh12');
      await expect(startMcpLogin('playwright', { port })).rejects.toMatchObject({ code: 'VALIDATION' });
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
      const [session] = await db.insert(sessions).values({ id: crypto.randomUUID(), projectId: project.id, title: 'Module CRM', status: 'running' }).returning();

      const config = await buildSessionMcpConfig(project.id);
      expect(config.mcpConfig.mcpServers.github).toBeUndefined();
      expect(config.skipped).toEqual([{ name: 'github', reason: GITHUB_MCP_APP_REQUIRED }]);
      await expect(resolveSessionMcpHeaders({ sessionId: session!.id, serverName: 'github' })).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const checked = await checkMcpServer('github', { trigger: 'schedule' });
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
    await createMcpServer({ name: 'linear', label: 'Linear', transport: 'http', url: 'https://mcp.linear.example/mcp', authKind: 'bearer', bearerToken: 'lin_token_session_0123' });
    const [session] = await db.insert(sessions).values({ id: crypto.randomUUID(), projectId: project.id, title: 'Module CRM', status: 'running' }).returning();

    await expect(resolveSessionMcpHeaders({ sessionId: session!.id, serverName: 'linear' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await setProjectMcpServer({ projectId: project.id, serverIdOrName: 'linear', enabled: true });
    expect(await resolveSessionMcpHeaders({ sessionId: session!.id, serverName: 'linear' })).toEqual({
      headers: { Authorization: 'Bearer lin_token_session_0123' },
      expiresAt: null,
    });
    await db.update(sessions).set({ status: 'stopped' }).where(eq(sessions.id, session!.id));
    await expect(resolveSessionMcpHeaders({ sessionId: session!.id, serverName: 'linear' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(resolveSessionMcpHeaders({ sessionId: crypto.randomUUID(), serverName: 'linear' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await db.update(sessions).set({ status: 'waiting_input' }).where(eq(sessions.id, session!.id));
    await db.update(projectMcpServers).set({ enabled: false });
    await expect(resolveSessionMcpHeaders({ sessionId: session!.id, serverName: 'linear' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
