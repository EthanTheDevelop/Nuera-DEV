import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditLog, githubSources, integrations, mcpServers, notifications, projectMcpServers } from '@nuera/db/schema';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/server/auth/session';
import { addInstallation, startFakeGithub, type FakeGithub } from '@/server/github/test/fake-github';
import { closeWebTestDb, prepareWebTestDatabase, useTestEncryptionKey } from '@/server/tenancy/test/db';
import { startFakeRunner, terminalDto, type FakeRunner } from '@/server/tenancy/test/fake-runner';
import { createTestAccount, createTestResources, truncateTenancy, type TestAccount, type TestResources } from '@/server/tenancy/test/fixtures';

/*
 * Isolation of every route of the Intégrations lot, table-driven (docs/MULTICOMPTE.md §1.1, §13):
 * account B, signed in, sends the ids of account A's space (GitHub source, MCP server, project).
 * Each answer must be byte for byte the answer to an UNKNOWN id (same status, same body), with no
 * request to either runner, no row written and no business audit. The lists and the multi-source
 * routes never show A's rows to B. An inventory check keeps the table complete.
 */

const state = vi.hoisted(() => ({ current: null as CurrentUser | null }));

vi.mock('@/server/auth/session', async () => {
  const { AppError } = await import('@/server/errors');
  return {
    getCurrentUser: async () => state.current,
    requireUser: async () => state.current,
    requireUserForApi: async () => {
      if (!state.current) throw new AppError('UNAUTHORIZED');
      return state.current;
    },
    isInstanceAdmin: (u: CurrentUser) => u.role === 'owner' || u.role === 'admin',
  };
});

const ORIGIN = 'http://localhost:3600';
const TOKEN = 'runner-token-for-w3-isolation-0123456789';
const ORG = { login: 'nuera-studio', id: 1001, type: 'Organization' as const };
const FULL = { contents: 'write', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read', issues: 'read' };

let fake: FakeGithub;
let runnerA: FakeRunner;
let runnerB: FakeRunner;
let a: TestAccount;
let b: TestAccount;
let resA: TestResources;
let resB: TestResources;
let sourceA: string;
let mcpServerA: string;

type Handler = (request: NextRequest, context: { params: Promise<unknown> }) => Promise<Response>;
type RouteModule = Record<string, Handler | unknown>;

interface Ids {
  sourceId: string;
  projectId: string;
  mcpServerId: string;
  mcpServerName: string;
}

interface Case {
  name: string;
  /** Route module, relative to this folder (inventory check). */
  file: string;
  load: () => Promise<RouteModule>;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: (ids: Ids) => string;
  params: (ids: Ids) => Record<string, string>;
  body?: (ids: Ids) => unknown;
}

const source = (suffix = '') => (ids: Ids) => `/api/integrations/github/sources/${ids.sourceId}${suffix}`;
const onSource = (ids: Ids) => ({ sourceId: ids.sourceId });
const mcp = (suffix = '', key: 'mcpServerId' | 'mcpServerName' = 'mcpServerId') => (ids: Ids) => `/api/integrations/mcp/${ids[key]}${suffix}`;
const onServer = (key: 'mcpServerId' | 'mcpServerName' = 'mcpServerId') => (ids: Ids) => ({ server: ids[key] });

const CASES: Case[] = [
  { name: 'GET /github/sources/[id]', file: './github/sources/[sourceId]/route', load: () => import('./github/sources/[sourceId]/route'), method: 'GET', url: source(), params: onSource },
  { name: 'PATCH /github/sources/[id]', file: './github/sources/[sourceId]/route', load: () => import('./github/sources/[sourceId]/route'), method: 'PATCH', url: source(), params: onSource, body: () => ({ label: 'Volée' }) },
  { name: 'DELETE /github/sources/[id]', file: './github/sources/[sourceId]/route', load: () => import('./github/sources/[sourceId]/route'), method: 'DELETE', url: source(), params: onSource },
  { name: 'POST /github/sources/[id]/check', file: './github/sources/[sourceId]/check/route', load: () => import('./github/sources/[sourceId]/check/route'), method: 'POST', url: source('/check'), params: onSource },
  { name: 'GET /github/repos?source=', file: './github/repos/route', load: () => import('./github/repos/route'), method: 'GET', url: (ids) => `/api/integrations/github/repos?source=${ids.sourceId}`, params: () => ({}) },
  { name: 'GET /github/install?source=', file: './github/install/route', load: () => import('./github/install/route'), method: 'GET', url: (ids) => `/api/integrations/github/install?source=${ids.sourceId}`, params: () => ({}) },
  { name: 'GET /coolify/applications?projectId=', file: './coolify/applications/route', load: () => import('./coolify/applications/route'), method: 'GET', url: (ids) => `/api/integrations/coolify/applications?projectId=${ids.projectId}`, params: () => ({}) },
  { name: 'GET /mcp?projectId=', file: './mcp/route', load: () => import('./mcp/route'), method: 'GET', url: (ids) => `/api/integrations/mcp?projectId=${ids.projectId}`, params: () => ({}) },
  { name: 'GET /mcp/[id]', file: './mcp/[server]/route', load: () => import('./mcp/[server]/route'), method: 'GET', url: mcp(), params: onServer() },
  { name: 'GET /mcp/[nom]', file: './mcp/[server]/route', load: () => import('./mcp/[server]/route'), method: 'GET', url: mcp('', 'mcpServerName'), params: onServer('mcpServerName') },
  { name: 'PATCH /mcp/[id]', file: './mcp/[server]/route', load: () => import('./mcp/[server]/route'), method: 'PATCH', url: mcp(), params: onServer(), body: () => ({ label: 'Volé', bearerToken: 'vole_0123456789' }) },
  { name: 'DELETE /mcp/[id]', file: './mcp/[server]/route', load: () => import('./mcp/[server]/route'), method: 'DELETE', url: mcp(), params: onServer() },
  { name: 'POST /mcp/[id]/check', file: './mcp/[server]/check/route', load: () => import('./mcp/[server]/check/route'), method: 'POST', url: mcp('/check'), params: onServer() },
  { name: 'POST /mcp/[id]/disable-all', file: './mcp/[server]/disable-all/route', load: () => import('./mcp/[server]/disable-all/route'), method: 'POST', url: mcp('/disable-all'), params: onServer() },
  { name: 'POST /mcp/[id]/login', file: './mcp/[server]/login/route', load: () => import('./mcp/[server]/login/route'), method: 'POST', url: mcp('/login'), params: onServer() },
  {
    name: 'PUT /mcp/[id A]/projects/[projet A]',
    file: './mcp/[server]/projects/[projectId]/route',
    load: () => import('./mcp/[server]/projects/[projectId]/route'),
    method: 'PUT',
    url: (ids) => `/api/integrations/mcp/${ids.mcpServerId}/projects/${ids.projectId}`,
    params: (ids) => ({ server: ids.mcpServerId, projectId: ids.projectId }),
    body: () => ({ enabled: true }),
  },
  {
    name: 'PUT /mcp/figma/projects/[projet A]',
    file: './mcp/[server]/projects/[projectId]/route',
    load: () => import('./mcp/[server]/projects/[projectId]/route'),
    method: 'PUT',
    url: (ids) => `/api/integrations/mcp/figma/projects/${ids.projectId}`,
    params: (ids) => ({ server: 'figma', projectId: ids.projectId }),
    body: () => ({ enabled: true }),
  },
];

/** Route modules of this folder that take no id (lists and the space's own state): checked separately. */
const WITHOUT_ID = [
  './route',
  './github/route',
  './github/check/route',
  './github/manifest/route',
  './github/callback/route',
  './github/setup/route',
  './github/sources/route',
  './coolify/route',
  './coolify/check/route',
];

function request(method: Case['method'], url: string, body: unknown): NextRequest {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers.origin = ORIGIN;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`${ORIGIN}${url}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

async function call(load: () => Promise<RouteModule>, method: Case['method'], url: string, params: Record<string, string>, body?: unknown): Promise<{ status: number; text: string; location: string | null }> {
  const handler = (await load())[method] as Handler;
  const response = await handler(request(method, url, body), { params: Promise.resolve(params) });
  return { status: response.status, text: await response.text(), location: response.headers.get('location') };
}

const unknownIds = (): Ids => ({
  sourceId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  mcpServerId: crypto.randomUUID(),
  mcpServerName: `inconnu-${crypto.randomUUID().slice(0, 8)}`,
});

const foreignIds = (): Ids => ({ sourceId: sourceA, projectId: resA.projectId, mcpServerId: mcpServerA, mcpServerName: 'secret-a' });

async function snapshot(): Promise<string> {
  const { db } = await import('@/server/db');
  const [sources, tokens, servers, activations, journal, sent] = await Promise.all([
    db.select().from(githubSources).orderBy(githubSources.id),
    db.select().from(integrations).orderBy(integrations.id),
    db.select().from(mcpServers).orderBy(mcpServers.id),
    db.select().from(projectMcpServers).orderBy(projectMcpServers.projectId, projectMcpServers.mcpServerId),
    db.select().from(auditLog).orderBy(auditLog.id),
    db.select().from(notifications).orderBy(notifications.id),
  ]);
  return JSON.stringify({ sources, tokens, servers, activations, journal, sent });
}

beforeAll(async () => {
  useTestEncryptionKey();
  await prepareWebTestDatabase(`${process.env.NUERA_DB_TEST_PREFIX ?? 'nuera_integrations'}_isolation`);
  fake = await startFakeGithub();
  runnerA = await startFakeRunner();
  runnerB = await startFakeRunner();
});

afterAll(async () => {
  await fake?.close();
  await runnerA?.close();
  await runnerB?.close();
  await closeWebTestDb();
});

beforeEach(async () => {
  vi.stubEnv('RUNNER_URL', runnerA.url);
  vi.stubEnv('RUNNER_TOKEN', TOKEN);
  vi.stubEnv('APP_URL', ORIGIN);
  vi.stubEnv('GITHUB_API_URL', fake.url);
  vi.stubEnv('GITHUB_WEB_URL', 'https://github.example.test');
  vi.stubEnv('GITHUB_FALLBACK_TOKEN', '');
  vi.stubEnv('NUERA_RATE_LIMIT_FACTOR', '100');
  await truncateTenancy();
  const { resetIntegrationState } = await import('@/server/integrations/test/db');
  await resetIntegrationState();
  fake.installations.length = 0;
  fake.repos.length = 0;
  fake.tokens.length = 0;
  fake.conversionCodes = new Set(['valid-code']);
  a = await createTestAccount({ role: 'owner', name: 'Ethan Martin', email: 'ethan@example.test' });
  b = await createTestAccount({ role: 'member', name: 'Camille Laurent', email: 'camille@example.test', environment: { configSource: 'db', name: 'VPS-4', url: runnerB.url } });
  resA = await createTestResources(a, 'secret-a');
  resB = await createTestResources(b, 'nuera-os');

  // A: a GitHub source installed on the organisation, a custom MCP server enabled in its project.
  const { completeManifestConversion, handleInstallationSetup, startManifestFlow } = await import('@/server/github/manifest');
  const form = await startManifestFlow({ userId: a.user.id, spaceId: a.space.id });
  sourceA = (await completeManifestConversion({ code: 'valid-code', userId: a.user.id, spaceId: a.space.id, sourceId: form.sourceId })).sourceId;
  addInstallation(fake, { id: 11, account: ORG, permissions: FULL, repos: ['secret-a'] }, [{ id: 1100, name: 'secret-a' }]);
  await handleInstallationSetup({ installationId: 11, setupAction: 'install', userId: a.user.id, spaceId: a.space.id, sourceId: sourceA, stateValid: true });
  const { createMcpServer, setProjectMcpServer } = await import('@/server/mcp/registry');
  const server = await createMcpServer(a.space.id, { name: 'secret-a', label: 'Secret A', transport: 'http', url: 'https://mcp.secret-a.example/mcp', authKind: 'bearer', bearerToken: 'secret_a_token_0123456789' });
  mcpServerA = server.id;
  await setProjectMcpServer({ spaceId: a.space.id, projectId: resA.projectId, serverIdOrName: mcpServerA, enabled: true });
  // B's registry exists too (ensured on read).
  const { ensurePresetServers } = await import('@/server/mcp/registry');
  await ensurePresetServers(b.space.id);

  state.current = b.user;
  fake.requests.length = 0;
  runnerA.requests.length = 0;
  runnerB.requests.length = 0;
});

describe('Intégrations · isolation of every route with an id', () => {
  it('answers A’s ids to B exactly like unknown ids: no runner call, no write, no audit', async () => {
    for (const item of CASES) {
      const ids = foreignIds();
      const before = await snapshot();
      const unknown = await call(item.load, item.method, item.url(unknownIds()), item.params(unknownIds()), item.body?.(unknownIds()));
      const foreign = await call(item.load, item.method, item.url(ids), item.params(ids), item.body?.(ids));
      expect(foreign.status, item.name).toBe(unknown.status);
      expect(foreign.text, item.name).toBe(unknown.text);
      expect(foreign.location, item.name).toBe(unknown.location);
      expect([404, 303], `${item.name} → ${foreign.status} ${foreign.text}`).toContain(foreign.status);
      expect(await snapshot(), item.name).toBe(before);
      expect(foreign.text, item.name).not.toMatch(/secret-a|Secret A|nuera-dev-test/);
    }
    expect(runnerA.requests).toHaveLength(0);
    expect(runnerB.requests).toHaveLength(0);
  });

  it('keeps the inventory of the routes of this folder complete', () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === 'route.ts') found.push(`./${path.relative(root, full).replace(/\\/g, '/').replace(/\.ts$/, '')}`);
      }
    };
    walk(root);
    const covered = new Set([...CASES.map((item) => item.file), ...WITHOUT_ID]);
    expect(found.filter((file) => !covered.has(file))).toEqual([]);
  });
});

describe('Intégrations · lists of the space only', () => {
  it('never shows A’s GitHub source, MCP server, activations or banners to B', async () => {
    const overview = await call(() => import('./route'), 'GET', '/api/integrations', {});
    expect(overview.status).toBe(200);
    expect(overview.text).not.toMatch(/secret-a|Secret A|nuera-dev-test|nuera-studio/);
    const github = await call(() => import('./github/route'), 'GET', '/api/integrations/github', {});
    expect(JSON.parse(github.text)).toMatchObject({ mode: 'none', sources: [] });
    const sources = await call(() => import('./github/sources/route'), 'GET', '/api/integrations/github/sources', {});
    expect(JSON.parse(sources.text)).toMatchObject({ sources: [], sourceCount: 0, canAddSource: true });
    const servers = await call(() => import('./mcp/route'), 'GET', '/api/integrations/mcp', {});
    const list = JSON.parse(servers.text) as { servers: Array<{ name: string; projects: Array<{ id: string }> }> };
    expect(list.servers.map((server) => server.name)).toEqual(['figma', 'github', 'coolify', 'playwright']);
    expect(list.servers.flatMap((server) => server.projects.map((project) => project.id))).toEqual(
      expect.not.arrayContaining([resA.projectId]),
    );
    expect(list.servers.flatMap((server) => server.projects.map((project) => project.id))).toContain(resB.projectId);
    const coolify = await call(() => import('./coolify/route'), 'GET', '/api/integrations/coolify', {});
    expect(JSON.parse(coolify.text)).toMatchObject({ configured: false });
    // The historical routes act on B's space only: nothing to disconnect, nothing checked in A.
    const before = await snapshot();
    const deleted = await call(() => import('./github/route'), 'DELETE', '/api/integrations/github', {});
    expect(JSON.parse(deleted.text)).toEqual({ deleted: false, appHtmlUrl: null });
    const install = await call(() => import('./github/install/route'), 'GET', '/api/integrations/github/install', {});
    expect(install.location).toBe(`${ORIGIN}/integrations?github=not_connected`);
    expect(await snapshot()).toBe(before);
    expect(fake.requests.filter((item) => item.path.startsWith('/app')).length).toBe(0);
  });

  it('serves A its own source through the per-source routes, and refuses the disconnection while a project uses it', async () => {
    state.current = a.user;
    const { db } = await import('@/server/db');
    const { projects } = await import('@nuera/db/schema');
    const { eq } = await import('drizzle-orm');
    await db.update(projects).set({ githubSourceId: sourceA }).where(eq(projects.id, resA.projectId));
    const view = await call(() => import('./github/sources/[sourceId]/route'), 'GET', `/api/integrations/github/sources/${sourceA}`, { sourceId: sourceA });
    expect(JSON.parse(view.text)).toMatchObject({ id: sourceA, label: 'nuera-studio', projects: [{ id: resA.projectId, name: 'Projet secret-a' }] });
    const refused = await call(() => import('./github/sources/[sourceId]/route'), 'DELETE', `/api/integrations/github/sources/${sourceA}`, { sourceId: sourceA });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.text)).toMatchObject({
      error: { code: 'CONFLICT', message: 'Cette source GitHub est utilisée par 1 projet actif : Projet secret-a.', projects: [{ id: resA.projectId, name: 'Projet secret-a' }] },
    });
    const renamed = await call(() => import('./github/sources/[sourceId]/route'), 'PATCH', `/api/integrations/github/sources/${sourceA}`, { sourceId: sourceA }, { label: 'Studio' });
    expect(JSON.parse(renamed.text)).toMatchObject({ label: 'Studio' });
    const install = await call(() => import('./github/install/route'), 'GET', `/api/integrations/github/install?source=${sourceA}`, {});
    expect(install.status).toBe(303);
    expect(install.location?.startsWith('https://github.example.test/apps/nuera-dev-test/installations/new?state=')).toBe(true);
    const repos = await call(() => import('./github/repos/route'), 'GET', `/api/integrations/github/repos?source=${sourceA}`, {});
    expect(JSON.parse(repos.text)).toMatchObject({ total: 1, repos: [{ fullName: 'nuera-studio/secret-a', sourceId: sourceA }] });
    expect(runnerA.requests).toHaveLength(0);
  });
});

describe('Intégrations · OAuth login terminal of an MCP server', () => {
  const login = (name = 'figma') => call(() => import('./mcp/[server]/login/route'), 'POST', `/api/integrations/mcp/${name}/login`, { server: name });

  async function setB(change: { role?: 'owner' | 'member'; status?: 'active' | 'suspended' }): Promise<void> {
    const { db } = await import('@/server/db');
    const { environments, spaceMembers } = await import('@nuera/db/schema');
    const { and, eq } = await import('drizzle-orm');
    const { invalidateContextCache } = await import('@/server/tenancy/context');
    if (change.role) await db.update(spaceMembers).set({ role: change.role }).where(and(eq(spaceMembers.spaceId, b.space.id), eq(spaceMembers.userId, b.user.id)));
    if (change.status) await db.update(environments).set({ status: change.status }).where(eq(environments.id, b.environment!.id));
    invalidateContextCache();
  }

  it('refuses a member who does not own the space and a suspended server, like the other login terminals, without calling the runner', async () => {
    const { LOGIN_TERMINAL_OWNER_ONLY } = await import('@/server/terminals');
    const before = await snapshot();
    await setB({ role: 'member' });
    for (const name of ['figma', 'inconnu']) {
      const refused = await login(name);
      expect(refused.status, name).toBe(403);
      expect(JSON.parse(refused.text), name).toMatchObject({ error: { code: 'FORBIDDEN', message: LOGIN_TERMINAL_OWNER_ONLY } });
    }
    await setB({ role: 'owner', status: 'suspended' });
    const suspended = await login();
    expect(suspended.status).toBe(403);
    expect(JSON.parse(suspended.text)).toMatchObject({ error: { code: 'FORBIDDEN', reason: 'ENVIRONMENT_DISABLED' } });
    expect(runnerA.requests).toHaveLength(0);
    expect(runnerB.requests).toHaveLength(0);
    expect(await snapshot()).toBe(before);
  });

  it("opens it on the owner's own server only", async () => {
    runnerB.handle((_req, res, recorded) => {
      if (recorded.path === '/v1/claude/mcp/sync') return runnerB.json(res, 200, { results: [{ name: 'figma', action: 'upsert', ok: true, raw: 'Added' }] });
      if (recorded.path === '/v1/terminals') return runnerB.json(res, 200, terminalDto({ id: 'term_login_b_0001', kind: 'mcp-login', ownerUserId: b.user.id }));
      return runnerB.json(res, 404, { error: { code: 'NOT_FOUND', message: 'Route inconnue.' } });
    });
    const opened = await login();
    expect(opened.status, opened.text).toBe(200);
    expect(JSON.parse(opened.text)).toMatchObject({ terminalId: 'term_login_b_0001', streamUrl: '/api/stream/terminals/term_login_b_0001' });
    expect(runnerB.requests.map((item) => item.path)).toEqual(['/v1/claude/mcp/sync', '/v1/terminals']);
    expect(JSON.parse(runnerB.requests[1]!.body)).toMatchObject({ kind: 'mcp-login', serverName: 'figma', actorUserId: b.user.id });
    expect(runnerA.requests).toHaveLength(0);
  });
});
