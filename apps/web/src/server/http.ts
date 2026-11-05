import 'server-only';
import type { NextRequest } from 'next/server';
import type { z, ZodType } from 'zod';
import { requireUserForApi, type CurrentUser } from '@/server/auth/session';
import { AppError, formatZodIssues, toAppError, toErrorResponse } from '@/server/errors';
import { checkRequestOrigin } from '@/server/security/origin';
import { assertRateLimit, type RateLimitRule } from '@/server/security/rate-limit';
import { getClientIp } from '@/server/security/request-info';
import { isValidRunnerAuthorization } from '@/server/security/runner-token';

/**
 * Route handler wrappers.
 *
 *   // app/api/projets/[id]/favori/route.ts
 *   export const POST = apiRoute({
 *     params: z.object({ id: z.uuid() }),
 *     body: z.object({ favorite: z.boolean() }),
 *     handler: async ({ params, body, user }) => setFavorite(params.id, body.favorite, user),
 *   });
 *
 * apiRoute: session required (2FA active) unless `auth: false`; Origin check on every non-GET
 * method; Zod parsing of params / query / JSON body (422 VALIDATION with a French detail);
 * optional rate limit (per IP + route); AppError → JSON `{ error: { code, message, … } }`;
 * unexpected errors → 500 INTERNAL without stack trace (logged on the server).
 * The handler may return a Response (passed through), `undefined` (204) or any JSON value (200).
 *
 * internalRoute: runner → web callbacks under /api/internal/*: `Authorization: Bearer RUNNER_TOKEN`
 * compared in constant time, no user session, no Origin check.
 */

type RouteParams = Record<string, string | string[] | undefined>;
type Infer<TSchema, TFallback> = TSchema extends ZodType ? z.output<TSchema> : TFallback;

export interface RouteContextLike {
  params: Promise<unknown>;
}

export type RouteHandler = (request: NextRequest, context: RouteContextLike) => Promise<Response>;

export interface ApiHandlerContext<TBody, TQuery, TParams, TUser> {
  request: NextRequest;
  body: TBody;
  query: TQuery;
  params: TParams;
  user: TUser;
  /** Client IP from the trusted proxy header (null in local development). */
  ip: string | null;
}

export interface ApiRouteOptions<
  TAuth extends boolean,
  TBodySchema extends ZodType | undefined,
  TQuerySchema extends ZodType | undefined,
  TParamsSchema extends ZodType | undefined,
> {
  /** Default true: requires the owner session (2FA active). */
  auth?: TAuth;
  body?: TBodySchema;
  query?: TQuerySchema;
  params?: TParamsSchema;
  /** Per IP (+ user) sliding window; `scope` defaults to the request path. */
  rateLimit?: RateLimitRule & { scope?: string };
  /** Maximum JSON body size in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  handler: (
    context: ApiHandlerContext<
      Infer<TBodySchema, undefined>,
      Infer<TQuerySchema, Record<string, string>>,
      Infer<TParamsSchema, RouteParams>,
      TAuth extends false ? null : CurrentUser
    >,
  ) => unknown;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function parseWith<TSchema extends ZodType>(schema: TSchema, value: unknown, what: string): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION', `${what} invalides.`, { detail: formatZodIssues(result.error) });
  }
  return result.data;
}

async function readJsonBody(request: NextRequest, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new AppError('VALIDATION', 'Requête trop volumineuse.');
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new AppError('VALIDATION', 'Requête trop volumineuse.');
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

export function apiRoute<
  TAuth extends boolean = true,
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
      const user = options.auth === false ? null : await requireUserForApi();

      if (options.rateLimit) {
        const scope = options.rateLimit.scope ?? `api:${request.nextUrl.pathname}`;
        assertRateLimit(scope, `${ip ?? 'unknown'}:${user?.id ?? 'anon'}`, options.rateLimit);
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
        user: user as TAuth extends false ? null : CurrentUser,
        ip,
      });
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

export { isValidRunnerAuthorization };

export interface InternalHandlerContext<TBody> {
  request: NextRequest;
  body: TBody;
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
      if (!isValidRunnerAuthorization(request.headers.get('authorization'))) {
        throw new AppError('UNAUTHORIZED', 'Jeton du runner invalide.');
      }
      let body: unknown = undefined;
      if (options.body) {
        const raw = await readJsonBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
        body = parseWith(options.body, raw, 'Données');
      }
      const result = await options.handler({ request, body: body as Infer<TBodySchema, undefined> });
      return toResponse(result);
    } catch (error) {
      if (isNextControlFlow(error)) throw error;
      logUnexpected(request, error);
      return toErrorResponse(error);
    }
  };
}
