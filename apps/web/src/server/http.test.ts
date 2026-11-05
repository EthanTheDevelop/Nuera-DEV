import { NextRequest } from 'next/server';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * apiRoute: order of the guards (Origin before the session), JSON body limits, and the rate-limit
 * scope (one window per method + route pattern, default rule on every mutation).
 */
const state = vi.hoisted(() => ({ signedIn: true, sessionChecks: 0 }));

vi.mock('@/server/auth/session', async () => {
  const { AppError } = await import('@/server/errors');
  return {
    requireUserForApi: async () => {
      state.sessionChecks += 1;
      if (!state.signedIn) throw new AppError('UNAUTHORIZED');
      return { id: 'owner', name: 'Owner', email: 'owner@example.test', image: null, twoFactorEnabled: true, authSessionId: 's1' };
    },
  };
});

const { apiRoute, defaultRateLimitScope, effectiveRouteRateLimit, DEFAULT_MUTATION_RATE_LIMIT } = await import('./http');
const { rateLimiter } = await import('./security/rate-limit');

const APP = 'http://localhost:3410';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function request(method: string, path: string, init: { origin?: string | null; body?: unknown; headers?: Record<string, string> } = {}): NextRequest {
  const headers = new Headers({ host: 'localhost:3410', ...init.headers });
  if (init.origin !== null) headers.set('origin', init.origin ?? APP);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(`${APP}${path}`, {
    method,
    headers,
    ...(init.body !== undefined ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) } : {}),
  });
}

const ctx = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });

beforeEach(() => {
  vi.stubEnv('APP_URL', APP);
  vi.stubEnv('NUERA_RATE_LIMIT_FACTOR', '1');
  state.signedIn = true;
  state.sessionChecks = 0;
  rateLimiter.reset();
});

describe('defaultRateLimitScope', () => {
  it('replaces ids by :id and keeps the method', () => {
    expect(defaultRateLimitScope('post', `/api/worktrees/${ID_A}/push`)).toBe('api:POST:/api/worktrees/:id/push');
    expect(defaultRateLimitScope('DELETE', `/api/projects/${ID_A}/worktrees/${ID_B}`)).toBe('api:DELETE:/api/projects/:id/worktrees/:id');
    expect(defaultRateLimitScope('GET', '/api/runs/42')).toBe('api:GET:/api/runs/:id');
    expect(defaultRateLimitScope('POST', '/api/integrations/mcp/github/check')).toBe('api:POST:/api/integrations/mcp/github/check');
  });

  it('gives every mutation a rule, never a read, and honours an explicit opt-out', () => {
    expect(effectiveRouteRateLimit('PATCH', undefined)).toEqual(DEFAULT_MUTATION_RATE_LIMIT);
    expect(effectiveRouteRateLimit('DELETE', undefined)).toEqual(DEFAULT_MUTATION_RATE_LIMIT);
    expect(effectiveRouteRateLimit('GET', undefined)).toBeNull();
    expect(effectiveRouteRateLimit('POST', false)).toBeNull();
    expect(effectiveRouteRateLimit('POST', { limit: 3, windowMs: 1000 })).toEqual({ limit: 3, windowMs: 1000 });
  });
});

describe('apiRoute', () => {
  it('refuses a cross-site mutation before reading the session', async () => {
    const handler = vi.fn<() => { ok: boolean }>(() => ({ ok: true }));
    const route = apiRoute({ handler });
    const response = await route(request('POST', '/api/x', { origin: 'https://evil.example' }), ctx());
    expect(response.status).toBe(403);
    expect(state.sessionChecks).toBe(0);
    expect(handler).not.toHaveBeenCalled();

    const noOrigin = await route(request('DELETE', '/api/x', { origin: null }), ctx());
    expect(noOrigin.status).toBe(403);
  });

  it('requires the owner session unless auth: false', async () => {
    state.signedIn = false;
    const route = apiRoute({ handler: () => ({ ok: true }) });
    expect((await route(request('GET', '/api/x'), ctx())).status).toBe(401);
    const open = apiRoute({ auth: false, handler: () => ({ ok: true }) });
    expect((await open(request('GET', '/api/x'), ctx())).status).toBe(200);
  });

  it('validates params and refuses oversized or non-JSON bodies', async () => {
    const route = apiRoute({
      params: z.object({ id: z.uuid() }),
      body: z.object({ name: z.string().max(10) }),
      maxBodyBytes: 64,
      handler: ({ body }) => body,
    });
    expect((await route(request('POST', '/api/x', { body: { name: 'a' } }), ctx({ id: 'nope' }))).status).toBe(422);
    expect((await route(request('POST', '/api/x', { body: { name: 'x'.repeat(100) } }), ctx({ id: ID_A }))).status).toBe(422);
    const text = new NextRequest(`${APP}/api/x`, { method: 'POST', headers: { origin: APP, 'content-type': 'text/plain' }, body: '{"name":"a"}' });
    expect((await route(text, ctx({ id: ID_A }))).status).toBe(422);
    const ok = await route(request('POST', '/api/x', { body: { name: 'a' } }), ctx({ id: ID_A }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ name: 'a' });
  });

  it('shares one window across ids of the same route, separate from its reads', async () => {
    const route = apiRoute({ rateLimit: { limit: 2, windowMs: 60_000 }, handler: () => undefined });
    expect((await route(request('POST', `/api/worktrees/${ID_A}/push`), ctx())).status).toBe(204);
    expect((await route(request('POST', `/api/worktrees/${ID_B}/push`), ctx())).status).toBe(204);
    const third = await route(request('POST', `/api/worktrees/${ID_A}/push`), ctx());
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBeTruthy();

    // GET polling of a resource must not consume the budget of its mutations.
    const resource = apiRoute({ rateLimit: { limit: 1, windowMs: 60_000 }, handler: () => undefined });
    const read = apiRoute({ rateLimit: { limit: 100, windowMs: 60_000 }, handler: () => ({ ok: true }) });
    for (let i = 0; i < 5; i += 1) await read(request('GET', `/api/sessions/${ID_A}`), ctx());
    expect((await resource(request('PATCH', `/api/sessions/${ID_A}`), ctx())).status).toBe(204);
  });

  it('applies the default rule to undeclared mutations only', async () => {
    const mutation = apiRoute({ handler: () => undefined });
    for (let i = 0; i < DEFAULT_MUTATION_RATE_LIMIT.limit; i += 1) {
      expect((await mutation(request('POST', `/api/projects/${ID_A}/restore`), ctx())).status).toBe(204);
    }
    expect((await mutation(request('POST', `/api/projects/${ID_B}/restore`), ctx())).status).toBe(429);

    const keystrokes = apiRoute({ rateLimit: false, handler: () => undefined });
    for (let i = 0; i < DEFAULT_MUTATION_RATE_LIMIT.limit + 5; i += 1) {
      expect((await keystrokes(request('POST', '/api/terminals/abcdefgh12345678/input'), ctx())).status).toBe(204);
    }
  });
});

describe('apiRoute · body cut by the client', () => {
  const streamed = (chunks: Uint8Array[], fail: boolean) =>
    new NextRequest(`${APP}/api/sessions/${ID_A}/input`, {
      method: 'POST',
      headers: { host: 'localhost:3410', origin: APP, 'content-type': 'application/json' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          if (fail) controller.error(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
          else controller.close();
        },
      }),
      duplex: 'half',
    } as unknown as ConstructorParameters<typeof NextRequest>[1]);

  it('answers 400 without an error log when the body is aborted, and stops reading past the limit', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = vi.fn<() => undefined>(() => undefined);
    const route = apiRoute({ body: z.object({ text: z.string() }), maxBodyBytes: 32, handler });
    const encode = (text: string) => new TextEncoder().encode(text);

    const aborted = await route(streamed([encode('{"text":"he')], true), ctx());
    expect(aborted.status).toBe(400);
    expect((await aborted.json()).error.message).toBe('Requête interrompue par le client.');

    const chunked = await route(streamed([encode('{"text":"'), encode('x'.repeat(40)), encode('"}')], false), ctx());
    expect(chunked.status).toBe(422);
    expect((await chunked.json()).error.message).toBe('Requête trop volumineuse.');

    expect((await route(streamed([encode('{"text":'), encode('"ok"}')], false), ctx())).status).toBe(204);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
