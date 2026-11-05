import { notifications, projects } from '@nuera/db/schema';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDatabase, resetTables, useTestEncryptionKey } from '@/server/integrations/test/db';

const TOKEN = 'runner-token-for-tests-0123456789abcdef';

beforeAll(async () => {
  await prepareTestDatabase('internal');
  useTestEncryptionKey();
  process.env.RUNNER_TOKEN = TOKEN;
  process.env.APP_URL = 'http://localhost:3104';
  delete process.env.GITHUB_FALLBACK_TOKEN;
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTables();
});

type Handler = (request: NextRequest, context: { params: Promise<unknown> }) => Promise<Response>;

async function call(handler: Handler, path: string, body: unknown, authorization?: string): Promise<Response> {
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
  check: (await import('./integrations/check/route')).POST as Handler,
});

describe('internal runner → web routes', () => {
  it('refuse a missing or wrong runner token', async () => {
    const all = await routes();
    const cases: Array<[Handler, string, unknown]> = [
      [all.notify, '/api/internal/notify', { kind: 'server', title: 'x' }],
      [all.mcpHeaders, '/api/internal/mcp-headers', { sessionId: crypto.randomUUID(), serverName: 'figma' }],
      [all.gitCredentials, '/api/internal/git-credentials', { projectId: crypto.randomUUID(), access: 'read' }],
      [all.check, '/api/internal/integrations/check', {}],
    ];
    for (const [handler, path, body] of cases) {
      for (const authorization of [undefined, 'Bearer wrong-token-wrong-token-wrong', `Basic ${TOKEN}`, TOKEN]) {
        const response = await call(handler, path, body, authorization);
        expect(response.status, `${path} with ${authorization ?? 'no token'}`).toBe(401);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
      }
    }
    const { db } = await import('@/server/db');
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it('notify: validates, creates the notification and deduplicates', async () => {
    const { notify } = await routes();
    const bad = await call(notify, '/api/internal/notify', { kind: 'server', title: '' }, `Bearer ${TOKEN}`);
    expect(bad.status).toBe(422);
    const body = { kind: 'session_finished', severity: 'success', title: 'Module CRM · pipeline est terminée', href: '/sessions/1', dedupKey: 'session:1:end' };
    const first = await call(notify, '/api/internal/notify', body, `Bearer ${TOKEN}`);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { created: boolean }).created).toBe(true);
    const second = await call(notify, '/api/internal/notify', body, `Bearer ${TOKEN}`);
    expect(((await second.json()) as { created: boolean }).created).toBe(false);
    const { db } = await import('@/server/db');
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it('git-credentials and mcp-headers answer with typed errors for unknown targets', async () => {
    const { gitCredentials, mcpHeaders } = await routes();
    const unknownProject = await call(gitCredentials, '/api/internal/git-credentials', { projectId: crypto.randomUUID(), access: 'write' }, `Bearer ${TOKEN}`);
    expect(unknownProject.status).toBe(404);
    const { db } = await import('@/server/db');
    const [project] = await db
      .insert(projects)
      .values({ slug: 'nuera-os', name: 'Nuera OS', githubFullName: 'nuera-studio/nuera-os', cloneUrl: 'https://github.com/nuera-studio/nuera-os.git', path: '/srv/dev/nuera-os', status: 'ready' })
      .returning();
    const notConnected = await call(gitCredentials, '/api/internal/git-credentials', { projectId: project!.id, access: 'read' }, `Bearer ${TOKEN}`);
    expect(notConnected.status).toBe(409);
    const unknownSession = await call(mcpHeaders, '/api/internal/mcp-headers', { sessionId: crypto.randomUUID(), serverName: 'figma' }, `Bearer ${TOKEN}`);
    expect(unknownSession.status).toBe(404);
    const invalid = await call(mcpHeaders, '/api/internal/mcp-headers', { sessionId: 'nope', serverName: 'figma' }, `Bearer ${TOKEN}`);
    expect(invalid.status).toBe(422);
  });

  it('integrations/check runs every configured check (nothing configured here)', async () => {
    const { check } = await routes();
    const response = await call(check, '/api/internal/integrations/check', { trigger: 'schedule' }, `Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
    const summary = (await response.json()) as { github: unknown; coolify: unknown; mcp: unknown[] };
    expect(summary).toMatchObject({ github: null, coolify: null, mcp: [] });
  });
});
