import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthResponseSchema, RUNNER_CONTRACT_VERSION, RUNNER_ROUTES, UptimeResponseSchema } from '@nuera/shared/runner';
import { parseRunnerEvent } from '@nuera/shared/events';
import { auth, dbReady, defaultServer, startTestRunner, type TestEnv } from './helpers';

describe.skipIf(!dbReady)('runner HTTP API (fastify.inject)', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await startTestRunner();
  }, 600_000);

  afterAll(async () => {
    await env?.close();
  }, 120_000);

  it('requires the bearer token on every route', async () => {
    const none = await env.runner.api.inject({ method: 'GET', url: '/v1/health' });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Jeton du runner manquant ou invalide.' } });
    const wrong = await env.runner.api.inject({ method: 'GET', url: '/v1/system/metrics', headers: { authorization: 'Bearer nope' } });
    expect(wrong.statusCode).toBe(401);
    const unknown = await env.runner.api.inject({ method: 'GET', url: '/v1/nothing', headers: auth });
    expect(unknown.statusCode).toBe(404);
  });

  it('accepts hook calls only with the token of a live session', async () => {
    const url = '/internal/hooks/7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f';
    const payload = JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'x' });
    const headers = (authorization: string) => ({ authorization, 'content-type': 'application/json' });
    // Unknown session, random token, or the RUNNER_TOKEN itself: 404 without any detail.
    for (const authorization of [`Bearer ${'a'.repeat(43)}`, auth.authorization, '']) {
      const res = await env.runner.hooks.inject({ method: 'POST', url, headers: headers(authorization), payload });
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe('');
    }
    const status = await env.runner.hooks.inject({ method: 'POST', url: '/internal/statusline/not-a-uuid', headers: headers(auth.authorization), payload: '{}' });
    expect(status.statusCode).toBe(404);
  });

  it('declares a handler for every route of the shared contract', () => {
    for (const [name, def] of Object.entries(RUNNER_ROUTES)) {
      const found = env.runner.api.hasRoute({ method: def.method, url: def.path });
      expect(found, name).toBe(true);
    }
  });

  it('validates inputs with the shared Zod schemas (uniform error body)', async () => {
    const res = await env.runner.api.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: JSON.stringify({ projectId: 'not-a-uuid', worktree: { mode: 'primary' } }),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; detail: string } };
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.detail).toContain('projectId');
    const missing = await env.runner.api.inject({ method: 'GET', url: '/v1/sessions/7f0b3c2e-1b2a-4c3d-9e8f-0a1b2c3d4e5f', headers: auth });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('serves health, metrics and uptime', async () => {
    const health = await env.runner.api.inject({ method: 'GET', url: '/v1/health', headers: auth });
    expect(health.statusCode).toBe(200);
    const h = HealthResponseSchema.parse(health.json());
    expect(h.git.available).toBe(true);
    expect(h.database.ok).toBe(true);
    expect(h.backend).toBe('pty');
    expect(h.claude.version).toContain('2.1.999');
    // Contract 2: the server this runner serves (found by its token), its state and the contract.
    const server = await defaultServer(env.db);
    expect(h).toMatchObject({ environment: { id: server.environmentId, name: 'VPS-3' }, state: 'ready', contractVersion: RUNNER_CONTRACT_VERSION });
    const metrics = await env.runner.api.inject({ method: 'GET', url: '/v1/system/metrics', headers: auth });
    const m = metrics.json() as { memory: { totalBytes: number; usedBytes: number }; cpuPercent: number; disk: { totalBytes: number } | null };
    expect(m.memory.totalBytes).toBeGreaterThan(m.memory.usedBytes);
    expect(m.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(m.disk?.totalBytes).toBeGreaterThan(0);
    await env.runner.services.uptime.beat();
    const uptime = await env.runner.api.inject({ method: 'GET', url: '/v1/system/uptime?days=7', headers: auth });
    const u = UptimeResponseSchema.parse(uptime.json());
    // The default server keeps the historical key (its availability history is not lost).
    expect(u.service).toBe('runner');
    expect(u.days).toHaveLength(7);
    expect(u.days[6]!.upMinutes).toBeGreaterThanOrEqual(1);
  });

  it('reports the Claude CLI status from the official commands only', async () => {
    const res = await env.runner.api.inject({ method: 'GET', url: '/v1/claude/status?refresh=1', headers: auth });
    expect(res.json()).toMatchObject({ installed: true, version: '2.1.999', state: 'connected', auth: { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' } });
    const mcp = await env.runner.api.inject({ method: 'GET', url: '/v1/claude/mcp/figma', headers: auth });
    expect(mcp.json()).toMatchObject({ name: 'figma', state: 'connected', statusLine: '✔ Connected' });
    const secret = await env.runner.api.inject({
      method: 'POST',
      url: '/v1/claude/mcp/sync',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: JSON.stringify({ upsert: [{ name: 'coolify', config: { type: 'http', url: 'https://c.test/mcp', headers: { Authorization: 'Bearer x' } } }] }),
    });
    expect(secret.statusCode).toBe(400);
  });

  it('answers stream.reset when Last-Event-ID comes from a previous runner instance', async () => {
    const abort = new AbortController();
    const res = await fetch(`${env.apiUrl}/v1/events`, { headers: { ...auth, 'last-event-id': '12345' }, signal: abort.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('stream.reset') && !text.includes('system.metrics')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    abort.abort();
    const frames = text.split('\n\n').map((f) => f.split('\n').find((l) => l.startsWith('data: '))?.slice(6)).filter(Boolean) as string[];
    const first = frames.map((f) => parseRunnerEvent(f)).find((e) => e && e.type !== 'heartbeat');
    expect(first?.type).toBe('stream.reset');
    expect(first?.type === 'stream.reset' && first.data.reason).toBe('runner_restarted');
  });

  it('publishes web notifications to the global stream', async () => {
    const seen: string[] = [];
    const off = env.runner.services.bus.subscribe('global', (e) => seen.push(e.type));
    const res = await env.runner.api.inject({
      method: 'POST',
      url: '/v1/events/publish',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'notification.created', data: { id: 'n1', kind: 'server', severity: 'info', title: 'Test', body: null, href: null, projectId: null, sessionId: null } }),
    });
    off();
    expect(res.statusCode).toBe(200);
    expect(seen).toContain('notification.created');
  });
});
