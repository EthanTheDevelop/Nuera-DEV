import { auditLog, environments, notifications, projectMcpServers, projects } from '@nuera/db/schema';
import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addInstallation, startFakeGithub, type FakeGithub } from '@/server/github/test/fake-github';
import { closeWebTestDb, prepareWebTestDatabase, useTestEncryptionKey } from '@/server/tenancy/test/db';
import { createTestAccount, createTestEnvironment, createTestResources, truncateTenancy, twoSpaces, type TestAccount, type TestResources } from '@/server/tenancy/test/fixtures';

/*
 * Runner → web callbacks with two servers: each token designates its server, and a runner only
 * ever obtains something about ITS server's resources. B's runner asking about A's project or
 * session gets exactly the « unknown » 404 (no credential, no MCP header, no notification), and the
 * attempt is journalled as security.runner_scope_violation.
 */

const TOKEN = 'runner-token-for-tests-0123456789abcdef';

let fake: FakeGithub;

beforeAll(async () => {
  await prepareWebTestDatabase(`${process.env.NUERA_DB_TEST_PREFIX ?? 'nuera_integrations'}_internal`);
  useTestEncryptionKey();
  process.env.APP_URL = 'http://localhost:3104';
  fake = await startFakeGithub();
  process.env.GITHUB_API_URL = fake.url;
  process.env.GITHUB_WEB_URL = 'https://github.example.test';
});

afterAll(async () => {
  await fake?.close();
  await closeWebTestDb();
});

let a: TestAccount;
let b: TestAccount;
let resA: TestResources;
let resB: TestResources;

beforeEach(async () => {
  vi.stubEnv('RUNNER_TOKEN', TOKEN);
  vi.stubEnv('GITHUB_FALLBACK_TOKEN', '');
  await truncateTenancy();
  const { resetIntegrationState } = await import('@/server/integrations/test/db');
  await resetIntegrationState();
  ({ a, b } = await twoSpaces());
  resA = await createTestResources(a, 'nuera-os');
  resB = await createTestResources(b, 'nuera-os');
});

type Handler = (request: NextRequest, context: { params: Promise<unknown> }) => Promise<Response>;

async function call(handler: Handler, path: string, body: unknown, authorization?: string | null): Promise<Response> {
  const request = new NextRequest(`http://localhost:3104${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
  });
  return handler(request, { params: Promise.resolve({}) });
}

const routes = async () => ({
  notify: (await import('./notify/route')).POST as Handler,
  mcpHeaders: (await import('./mcp-headers/route')).POST as Handler,
  gitCredentials: (await import('./git-credentials/route')).POST as Handler,
});

const { db } = await import('@/server/db');

async function violations() {
  return db.select().from(auditLog).where(eq(auditLog.action, 'security.runner_scope_violation'));
}

async function errorOf(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

describe('internal routes · authentication of the calling server', () => {
  it('refuse a missing or wrong token (401) on every route, before reading the body', async () => {
    const all = await routes();
    const cases: Array<[Handler, string, unknown]> = [
      [all.notify, '/api/internal/notify', { kind: 'server', title: 'x' }],
      [all.mcpHeaders, '/api/internal/mcp-headers', { sessionId: crypto.randomUUID(), serverName: 'figma' }],
      [all.gitCredentials, '/api/internal/git-credentials', { projectId: crypto.randomUUID(), access: 'read' }],
    ];
    for (const [handler, path, body] of cases) {
      for (const authorization of [undefined, 'Bearer wrong-token-wrong-token-wrong', `Basic ${TOKEN}`, TOKEN]) {
        const response = await call(handler, path, body, authorization);
        expect(response.status, `${path} with ${authorization ?? 'no token'}`).toBe(401);
        expect(await response.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Jeton du runner invalide.' } });
      }
    }
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it('refuse a suspended or retired server (403) on every route', async () => {
    const all = await routes();
    for (const status of ['suspended', 'retired'] as const) {
      await db.update(environments).set({ status }).where(eq(environments.id, b.environment!.id));
      for (const [handler, path, body] of [
        [all.notify, '/api/internal/notify', { kind: 'server', title: 'x' }],
        [all.mcpHeaders, '/api/internal/mcp-headers', { sessionId: resB.sessionId, serverName: 'figma' }],
        [all.gitCredentials, '/api/internal/git-credentials', { projectId: resB.projectId, access: 'write' }],
      ] as Array<[Handler, string, unknown]>) {
        const response = await call(handler, path, body, `Bearer ${b.token}`);
        expect(response.status, `${path} (${status})`).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN', message: 'Ce serveur est suspendu.' } });
      }
    }
    expect(await db.select().from(notifications)).toHaveLength(0);
  });
});

describe('internal routes · git-credentials', () => {
  it("never gives runner B a credential for A's project: same 404 as an unknown project, journalled", async () => {
    const { gitCredentials } = await routes();
    const unknown = await errorOf(await call(gitCredentials, '/api/internal/git-credentials', { projectId: crypto.randomUUID(), access: 'write' }, `Bearer ${b.token}`));
    expect(unknown).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Projet introuvable.' } } });
    expect(await violations()).toHaveLength(0);

    for (const access of ['read', 'write'] as const) {
      const foreign = await errorOf(await call(gitCredentials, '/api/internal/git-credentials', { projectId: resA.projectId, access }, `Bearer ${b.token}`));
      expect(foreign).toEqual(unknown);
    }
    const logged = await violations();
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({
      actorKind: 'runner',
      actorUserId: null,
      environmentId: b.environment!.id,
      spaceId: b.space.id,
      targetType: 'project',
      targetId: resA.projectId,
      summary: "runner « VPS-4 » : accès refusé à un élément d'un autre serveur",
    });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'integration.github.write_token_issued'))).toHaveLength(0);
  });

  it('serves each runner for its own projects (here: GitHub not connected → 409)', async () => {
    const { gitCredentials } = await routes();
    const own = await call(gitCredentials, '/api/internal/git-credentials', { projectId: resA.projectId, access: 'read' }, `Bearer ${TOKEN}`);
    expect(own.status).toBe(409);
    const ownB = await call(gitCredentials, '/api/internal/git-credentials', { projectId: resB.projectId, access: 'read' }, `Bearer ${b.token}`);
    expect(ownB.status).toBe(409);
    // And the default server cannot reach B's project either.
    const crossed = await call(gitCredentials, '/api/internal/git-credentials', { projectId: resB.projectId, access: 'read' }, `Bearer ${TOKEN}`);
    expect(crossed.status).toBe(404);
    expect(await violations()).toHaveLength(1);
  });

  it("keeps the instance's GitHub credentials (here GITHUB_FALLBACK_TOKEN) for the default server", async () => {
    vi.stubEnv('GITHUB_FALLBACK_TOKEN', 'ghp_fallback0123456789abcdefghijklmnop');
    const { gitCredentials } = await routes();
    const own = await call(gitCredentials, '/api/internal/git-credentials', { projectId: resA.projectId, access: 'read' }, `Bearer ${TOKEN}`);
    expect(own.status).toBe(200);
    expect(((await own.json()) as { extraHeader: string }).extraHeader).toMatch(/^AUTHORIZATION: basic /);

    // B's own project: never the token of A's space (B has no GitHub source).
    for (const access of ['read', 'write'] as const) {
      const other = await call(gitCredentials, '/api/internal/git-credentials', { projectId: resB.projectId, access }, `Bearer ${b.token}`);
      expect(await errorOf(other)).toEqual({
        status: 409,
        body: { error: { code: 'CONFLICT', message: "GitHub n'est pas connecté : créez l'application GitHub depuis Intégrations." } },
      });
    }
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'integration.github.write_token_issued'))).toHaveLength(0);
    expect(await violations()).toHaveLength(0);
  });
});

describe('internal routes · mcp-headers', () => {
  it("never gives runner B the MCP headers of A's session: same 404 as an unknown session, journalled", async () => {
    const { mcpHeaders } = await routes();
    const unknown = await errorOf(await call(mcpHeaders, '/api/internal/mcp-headers', { sessionId: crypto.randomUUID(), serverName: 'figma' }, `Bearer ${b.token}`));
    expect(unknown).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Session inconnue.' } } });
    const foreign = await errorOf(await call(mcpHeaders, '/api/internal/mcp-headers', { sessionId: resA.sessionId, serverName: 'figma' }, `Bearer ${b.token}`));
    expect(foreign).toEqual(unknown);
    expect(await violations()).toMatchObject([{ targetType: 'session', targetId: resA.sessionId, environmentId: b.environment!.id }]);

    // Its own session passes the ownership check; then B's own registry decides (figma not enabled
    // for B's project).
    const own = await call(mcpHeaders, '/api/internal/mcp-headers', { sessionId: resB.sessionId, serverName: 'figma' }, `Bearer ${b.token}`);
    expect(await errorOf(own)).toEqual({ status: 403, body: { error: { code: 'FORBIDDEN', message: "Ce serveur MCP n'est pas activé pour le projet de la session." } } });
    // The default server's own session passes the ownership check (what follows is the registry's).
    const ownA = await call(mcpHeaders, '/api/internal/mcp-headers', { sessionId: resA.sessionId, serverName: 'figma' }, `Bearer ${TOKEN}`);
    expect(await errorOf(ownA)).not.toEqual(unknown);
    expect(await violations()).toHaveLength(1);
    const invalid = await call(mcpHeaders, '/api/internal/mcp-headers', { sessionId: 'nope', serverName: 'figma' }, `Bearer ${b.token}`);
    expect(invalid.status).toBe(422);
  });
});

describe('internal routes · notify', () => {
  it('validates, notifies the members of the caller space and deduplicates', async () => {
    const { notify } = await routes();
    const bad = await call(notify, '/api/internal/notify', { kind: 'server', title: '' }, `Bearer ${b.token}`);
    expect(bad.status).toBe(422);

    const body = { kind: 'session_finished', severity: 'success', title: 'Module CRM · pipeline est terminée', href: `/workspace/${resB.sessionId}`, sessionId: resB.sessionId, projectId: resB.projectId, dedupKey: `session:${resB.sessionId}:end` };
    const first = await call(notify, '/api/internal/notify', body, `Bearer ${b.token}`);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { created: boolean; recipients: number; notification: { id: string } };
    expect(firstBody).toMatchObject({ created: true, recipients: 1 });
    expect(firstBody.notification.id).toEqual(expect.any(String));
    const second = await call(notify, '/api/internal/notify', body, `Bearer ${b.token}`);
    expect(((await second.json()) as { created: boolean }).created).toBe(false);

    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: b.user.id, spaceId: b.space.id, sessionId: resB.sessionId, projectId: resB.projectId });
  });

  it("refuses A's session or project from runner B (404, journalled) and notifies nobody", async () => {
    const { notify } = await routes();
    const viaSession = await errorOf(await call(notify, '/api/internal/notify', { kind: 'session_finished', title: 'x', sessionId: resA.sessionId }, `Bearer ${b.token}`));
    expect(viaSession).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Session introuvable.' } } });
    const viaProject = await errorOf(await call(notify, '/api/internal/notify', { kind: 'operation_failed', title: 'x', projectId: resA.projectId }, `Bearer ${b.token}`));
    expect(viaProject).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Projet introuvable.' } } });
    expect(await db.select().from(notifications)).toHaveLength(0);
    expect(await violations()).toHaveLength(2);
  });

  it('keeps a notification whose session is gone (link dropped), for the caller space only', async () => {
    const { notify } = await routes();
    const response = await call(notify, '/api/internal/notify', { kind: 'server', title: 'Le serveur a redémarré', sessionId: crypto.randomUUID() }, `Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
    const rows = await db.select().from(notifications);
    expect(rows).toMatchObject([{ userId: a.user.id, spaceId: a.space.id, sessionId: null }]);
  });

  it('sends the events of an unassigned server to the administrators only', async () => {
    const admin = await createTestAccount({ role: 'admin', environment: false });
    const unassigned = await createTestEnvironment({ spaceId: null, name: 'VPS-9' });
    const { notify } = await routes();
    const response = await call(notify, '/api/internal/notify', { kind: 'server', title: 'Le serveur VPS-9 a démarré' }, `Bearer ${unassigned.token}`);
    expect(response.status).toBe(200);
    const recipients = (await db.select({ userId: notifications.userId }).from(notifications)).map((row) => row.userId).sort();
    expect(recipients).toEqual([a.user.id, admin.user.id].sort());
    expect(recipients).not.toContain(b.user.id);
  });
});

describe('internal routes · credentials of the project space', () => {
  const ORG = { login: 'nuera-studio', id: 1001, type: 'Organization' as const };
  const FULL = { contents: 'write', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read', issues: 'read' };

  /** A GitHub source of the account's space (its own app) installed on the organisation. */
  async function sourceOf(account: TestAccount, appId: number, installationId: number): Promise<string> {
    const { completeManifestConversion, handleInstallationSetup, startManifestFlow } = await import('@/server/github/manifest');
    let code = 'valid-code';
    if (appId === fake.appId) fake.conversionCodes.add(code);
    else {
      code = `code-${appId}`;
      fake.appCodes.set(code, { appId, slug: `nuera-dev-${appId}`, name: `Nuera Dev ${appId}`, owner: ORG });
    }
    const form = await startManifestFlow({ userId: account.user.id, spaceId: account.space.id });
    const { sourceId } = await completeManifestConversion({ code, userId: account.user.id, spaceId: account.space.id, sourceId: form.sourceId });
    addInstallation(fake, { id: installationId, appId, account: ORG, permissions: FULL, repos: ['nuera-os'] }, [{ id: 777, name: 'nuera-os' }]);
    await handleInstallationSetup({ installationId, setupAction: 'install', userId: account.user.id, spaceId: account.space.id, sourceId, stateValid: true });
    return sourceId;
  }

  beforeEach(() => {
    fake.tokens.length = 0;
    fake.installations.length = 0;
    fake.repos.length = 0;
    fake.apps.splice(1);
    fake.appCodes.clear();
  });

  it("gives each runner a token of its project's source only", async () => {
    const sourceA = await sourceOf(a, fake.appId, 11);
    const sourceB = await sourceOf(b, 5151, 41);
    await db.update(projects).set({ githubSourceId: sourceA }).where(eq(projects.id, resA.projectId));
    const { gitCredentials } = await routes();
    const ownA = await call(gitCredentials, '/api/internal/git-credentials', { projectId: resA.projectId, access: 'write' }, `Bearer ${TOKEN}`);
    expect(ownA.status).toBe(200);
    expect(fake.tokens.at(-1)).toMatchObject({ appId: fake.appId, installationId: 11, repositories: ['nuera-os'] });

    // B's project has no source yet: resolved in B's space only, then bound to B's source.
    const ownB = await call(gitCredentials, '/api/internal/git-credentials', { projectId: resB.projectId, access: 'read' }, `Bearer ${b.token}`);
    expect(ownB.status).toBe(200);
    expect(fake.tokens.at(-1)).toMatchObject({ appId: 5151, installationId: 41 });
    const [boundB] = await db.select().from(projects).where(eq(projects.id, resB.projectId));
    expect(boundB?.githubSourceId).toBe(sourceB);
    // Write token issued to A is journalled with its source.
    const [issued] = await db.select().from(auditLog).where(eq(auditLog.action, 'integration.github.write_token_issued'));
    expect(issued).toMatchObject({ spaceId: a.space.id, environmentId: a.environment!.id });
    expect((issued!.metadata as { sourceId?: string }).sourceId).toBe(sourceA);
    // Crossed: 404, no token.
    const count = fake.tokens.length;
    expect((await call(gitCredentials, '/api/internal/git-credentials', { projectId: resA.projectId, access: 'read' }, `Bearer ${b.token}`)).status).toBe(404);
    expect(fake.tokens.length).toBe(count);
  });

  it('serves the MCP headers of the session space, refuses an unexpected URL', async () => {
    const { mcpHeaders } = await routes();
    const { createMcpServer } = await import('@/server/mcp/registry');
    const server = await createMcpServer(b.space.id, { name: 'linear', label: 'Linear', transport: 'http', url: 'https://mcp.linear.example/mcp', authKind: 'bearer', bearerToken: 'lin_token_b_0123456789' });
    await db.insert(projectMcpServers).values({ projectId: resB.projectId, mcpServerId: server.id, enabled: true });
    const body = { sessionId: resB.sessionId, serverName: 'linear', projectId: resB.projectId };
    const ok = await call(mcpHeaders, '/api/internal/mcp-headers', { ...body, serverUrl: 'https://mcp.linear.example/mcp' }, `Bearer ${b.token}`);
    expect(await ok.json()).toEqual({ headers: { Authorization: 'Bearer lin_token_b_0123456789' }, expiresAt: null });
    const wrong = await call(mcpHeaders, '/api/internal/mcp-headers', { ...body, serverUrl: 'https://attacker.example/mcp' }, `Bearer ${b.token}`);
    expect(await errorOf(wrong)).toEqual({ status: 403, body: { error: { code: 'FORBIDDEN', message: "Adresse du serveur MCP inattendue : aucun accès n'est délivré." } } });
    // A's session asking for B's server name: A's registry has no such server.
    const crossed = await call(mcpHeaders, '/api/internal/mcp-headers', { sessionId: resA.sessionId, serverName: 'linear' }, `Bearer ${TOKEN}`);
    expect(await errorOf(crossed)).toEqual({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'Serveur MCP désactivé.' } } });
    expect(await db.select().from(projectMcpServers).where(and(eq(projectMcpServers.projectId, resA.projectId)))).toHaveLength(0);
  });
});
