import 'server-only';
import type { NextRequest } from 'next/server';
import type { z, ZodType } from 'zod';
import { isInstanceAdmin, requireUserForApi, type CurrentUser } from '@/server/auth/session';
import { AppError, formatZodIssues, toAppError, toErrorResponse } from '@/server/errors';
import { checkRequestOrigin } from '@/server/security/origin';
import { assertRateLimit, type RateLimitRule } from '@/server/security/rate-limit';
import { getClientIp } from '@/server/security/request-info';
import { isValidRunnerAuthorization, resolveRunnerCaller, type CallerEnvironment } from '@/server/security/runner-token';
import { requireContextForApi, type RequestContext } from '@/server/tenancy/context';

/**
 * Route handler wrappers.
 *
 *   // app/api/projets/[id]/favori/route.ts
 *   export const POST = apiRoute({
 *     params: z.object({ id: z.uuid() }),
 *     body: z.object({ favorite: z.boolean() }),
 *     handler: async ({ params, body, ctx }) => setFavorite(ctx, params.id, body.favorite),
 *   });
 *
 * apiRoute: identity by `auth` level (docs/MULTICOMPTE.md §5):
 *   - `'space'` (DEFAULT): signed-in account (2FA active) + its request context (space, server) → `ctx`;
 *   - `'user'`: signed-in account only (`ctx` null) — account-level routes (push, notifications…);
 *   - `'admin'`: owner or administrator of the instance, else 403 (`ctx` null);
 *   - `false`: public (`user` and `ctx` null).
 * Origin check on every non-GET method (before the session is read); rate limit per IP + account;
 * Zod parsing of params / query / JSON body (422 VALIDATION with a French detail);
 * optional rate limit (per IP + route); AppError → JSON `{ error: { code, message, … } }`;
 * unexpected errors → 500 INTERNAL without stack trace (logged on the server).
 * The handler may return a Response (passed through), `undefined` (204) or any JSON value (200).
 *
 * internalRoute: runner → web callbacks under /api/internal/*: `Authorization: Bearer <jeton du
 * serveur>` resolved to the calling server (`environment`: RUNNER_TOKEN in constant time for the
 * default server, sha256 lookup for the others), no user session, no Origin check. 401 « Jeton du
 * runner invalide. » for an unknown token, 403 « Ce serveur est suspendu. » for a suspended or
 * retired server. Each route then checks that the resource belongs to that server.
 */

type RouteParams = Record<string, string | string[] | undefined>;
type Infer<TSchema, TFallback> = TSchema extends ZodType ? z.output<TSchema> : TFallback;

export interface RouteContextLike {
  params: Promise<unknown>;
}

export type RouteHandler = (request: NextRequest, context: RouteContextLike) => Promise<Response>;

/** Identity required by a route (see the module comment). */
export type RouteAuth = false | 'user' | 'space' | 'admin';

/** What the handler receives for each level. */
export type RouteIdentity<TAuth extends RouteAuth> = TAuth extends false
  ? { user: null; ctx: null }
  : TAuth extends 'space'
    ? { user: CurrentUser; ctx: RequestContext }
    : { user: CurrentUser; ctx: null };

export type ApiHandlerContext<TBody, TQuery, TParams, TAuth extends RouteAuth = 'space'> = {
  request: NextRequest;
  body: TBody;
  query: TQuery;
  params: TParams;
  /** Client IP from the trusted proxy header (null in local development). */
  ip: string | null;
} & RouteIdentity<TAuth>;

export interface ApiRouteOptions<
  TAuth extends RouteAuth,
  TBodySchema extends ZodType | undefined,
  TQuerySchema extends ZodType | undefined,
  TParamsSchema extends ZodType | undefined,
> {
  /** Default `'space'`: account (2FA active) + request context. */
  auth?: TAuth;
  body?: TBodySchema;
  query?: TQuerySchema;
  params?: TParamsSchema;
  /**
   * Per IP (+ user) sliding window; `scope` defaults to `api:<METHOD>:<route pattern>` (ids
   * replaced by `:id`, see {@link defaultRateLimitScope}). Mutations without a declared rule get
   * {@link DEFAULT_MUTATION_RATE_LIMIT}; `false` opts out (keystrokes of a terminal only).
   */
  rateLimit?: (RateLimitRule & { scope?: string }) | false;
  /** Maximum JSON body size in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  handler: (
    context: ApiHandlerContext<
      Infer<TBodySchema, undefined>,
      Infer<TQuerySchema, Record<string, string>>,
      Infer<TParamsSchema, RouteParams>,
      TAuth
    >,
  ) => unknown;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Applied to every POST/PUT/PATCH/DELETE route that declares no rule of its own. */
export const DEFAULT_MUTATION_RATE_LIMIT: RateLimitRule = { limit: 120, windowMs: 60_000 };

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rate-limit scope of a request: one window per method and route pattern, not per concrete URL —
 * otherwise each new id (session, worktree…) would start a fresh window, and the GET polling of a
 * resource would eat the budget of its PATCH/DELETE (same path, same key).
 */
export function defaultRateLimitScope(method: string, pathname: string): string {
  const pattern = pathname
    .split('/')
    .map((segment) => (UUID_SEGMENT.test(segment) || /^\d+$/.test(segment) ? ':id' : segment))
    .join('/');
  return `api:${method.toUpperCase()}:${pattern}`;
}

/** Rule applied to a request (`null` = none). */
export function effectiveRouteRateLimit(
  method: string,
  declared: (RateLimitRule & { scope?: string }) | false | undefined,
): (RateLimitRule & { scope?: string }) | null {
  if (declared === false) return null;
  if (declared) return declared;
  return SAFE_METHODS.has(method.toUpperCase()) ? null : DEFAULT_MUTATION_RATE_LIMIT;
}

function parseWith<TSchema extends ZodType>(schema: TSchema, value: unknown, what: string): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION', `${what} invalides.`, { detail: formatZodIssues(result.error) });
  }
  return result.data;
}

/** The client went away while its body was being read: answered (to nobody) without an error log. */
function abortedBody(): AppError {
  return new AppError('VALIDATION', 'Requête interrompue par le client.', { status: 400 });
}

/**
 * Body as text, read as a stream: stops as soon as it exceeds `maxBytes` (a chunked body declares no
 * Content-Length), and a body cut by the client (aborted fetch, closed tab) ends quietly as a 400
 * instead of an « Erreur inattendue » logged with its stack.
 */
async function readBodyText(request: NextRequest, maxBytes: number): Promise<string> {
  if (request.signal?.aborted) throw abortedBody();
  const stream = request.body;
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new AppError('VALIDATION', 'Requête trop volumineuse.');
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw abortedBody();
  }
  return text + decoder.decode();
}

async function readJsonBody(request: NextRequest, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new AppError('VALIDATION', 'Requête trop volumineuse.');
  const text = await readBodyText(request, maxBytes);
  if (text.trim() === '') return undefined;
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new AppError('VALIDATION', 'Corps JSON attendu (Content-Type: application/json).');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('VALIDATION', 'Corps JSON illisible.');
  }
}

function toResponse(result: unknown): Response {
  if (result instanceof Response) return result;
  if (result === undefined) return new Response(null, { status: 204 });
  return Response.json(result, { headers: { 'cache-control': 'no-store' } });
}

function logUnexpected(request: NextRequest, error: unknown): void {
  const appError = toAppError(error);
  if (appError.code === 'INTERNAL') {
    console.error(`[api] ${request.method} ${request.nextUrl.pathname}`, error);
  }
}

/** Resolves the identity of a request for `auth` (throws AppError 401 / 403). */
async function resolveIdentity(auth: RouteAuth): Promise<{ user: CurrentUser | null; ctx: RequestContext | null }> {
  if (auth === false) return { user: null, ctx: null };
  if (auth === 'space') {
    const ctx = await requireContextForApi();
    return { user: ctx.user, ctx };
  }
  const user = await requireUserForApi();
  if (auth === 'admin' && !isInstanceAdmin(user)) {
    throw new AppError('FORBIDDEN', 'Action réservée aux administrateurs.');
  }
  return { user, ctx: null };
}

export function apiRoute<
  TAuth extends RouteAuth = 'space',
  TBodySchema extends ZodType | undefined = undefined,
  TQuerySchema extends ZodType | undefined = undefined,
  TParamsSchema extends ZodType | undefined = undefined,
>(options: ApiRouteOptions<TAuth, TBodySchema, TQuerySchema, TParamsSchema>): RouteHandler {
  return async (request, context) => {
    try {
      const method = request.method.toUpperCase();
      if (!SAFE_METHODS.has(method)) {
        const origin = checkRequestOrigin(request);
        if (!origin.ok) throw new AppError('FORBIDDEN', 'Requête refusée : origine non autorisée.', { detail: origin.reason });
      }

      const ip = getClientIp(request.headers);
      const { user, ctx } = await resolveIdentity(options.auth ?? 'space');

      const rule = effectiveRouteRateLimit(method, options.rateLimit);
      if (rule) {
        const scope = rule.scope ?? defaultRateLimitScope(method, request.nextUrl.pathname);
        assertRateLimit(scope, `${ip ?? 'unknown'}:${user?.id ?? 'anon'}`, { limit: rule.limit, windowMs: rule.windowMs });
      }

      const rawParams = ((await context?.params) ?? {}) as RouteParams;
      const params = options.params ? parseWith(options.params, rawParams, 'Paramètres') : rawParams;
      const rawQuery = Object.fromEntries(request.nextUrl.searchParams.entries());
      const query = options.query ? parseWith(options.query, rawQuery, 'Paramètres de requête') : rawQuery;

      let body: unknown = undefined;
      if (options.body) {
        const raw = await readJsonBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
        body = parseWith(options.body, raw, 'Données');
      }

      const result = await options.handler({
        request,
        body: body as Infer<TBodySchema, undefined>,
        query: query as Infer<TQuerySchema, Record<string, string>>,
        params: params as Infer<TParamsSchema, RouteParams>,
        ip,
        user,
        ctx,
        // The identity matches TAuth by construction (resolveIdentity).
      } as unknown as ApiHandlerContext<
        Infer<TBodySchema, undefined>,
        Infer<TQuerySchema, Record<string, string>>,
        Infer<TParamsSchema, RouteParams>,
        TAuth
      >);
      return toResponse(result);
    } catch (error) {
      if (isNextControlFlow(error)) throw error;
      logUnexpected(request, error);
      return toErrorResponse(error);
    }
  };
}

/** redirect()/notFound() thrown inside a handler must reach Next untouched. */
function isNextControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && (digest.startsWith('NEXT_REDIRECT') || digest.startsWith('NEXT_HTTP_ERROR_FALLBACK'));
}

export { isValidRunnerAuthorization, type CallerEnvironment };

export interface InternalHandlerContext<TBody> {
  request: NextRequest;
  body: TBody;
  /** Server whose runner called (resolved from its token). */
  environment: CallerEnvironment;
}

export interface InternalRouteOptions<TBodySchema extends ZodType | undefined> {
  body?: TBodySchema;
  maxBodyBytes?: number;
  handler: (context: InternalHandlerContext<Infer<TBodySchema, undefined>>) => unknown;
}

export function internalRoute<TBodySchema extends ZodType | undefined = undefined>(
  options: InternalRouteOptions<TBodySchema>,
): RouteHandler {
  return async (request) => {
    try {
      const environment = await resolveRunnerCaller(request.headers.get('authorization'));
      if (!environment) throw new AppError('UNAUTHORIZED', 'Jeton du runner invalide.');
      let body: unknown = undefined;
      if (options.body) {
        const raw = await readJsonBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
        body = parseWith(options.body, raw, 'Données');
      }
      const result = await options.handler({ request, body: body as Infer<TBodySchema, undefined>, environment });
      return toResponse(result);
    } catch (error) {
      if (isNextControlFlow(error)) throw error;
      logUnexpected(request, error);
      return toErrorResponse(error);
    }
  };
}
