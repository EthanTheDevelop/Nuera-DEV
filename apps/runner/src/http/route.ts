import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RUNNER_ROUTES, type RunnerRouteDef, type RunnerRouteName, type RunnerRouteParsed } from '@nuera/shared/runner';
import type { z } from 'zod';
import { RunnerError, toErrorBody, toRunnerError } from '../errors';

type RunnerRoutes = typeof RUNNER_ROUTES;

export type RouteContext<K extends RunnerRouteName> = RunnerRouteParsed<K> & {
  request: FastifyRequest;
  reply: FastifyReply;
};

/** What a JSON handler returns: the *input* of the response schema (parsed before sending). */
export type RouteResult<K extends RunnerRouteName> = RunnerRoutes[K] extends { response: infer R }
  ? R extends z.ZodType
    ? z.input<R>
    : never
  : void;

type Handler<K extends RunnerRouteName> = (ctx: RouteContext<K>) => Promise<RouteResult<K>>;

/** Registers one route of the shared contract: params/query/body parsed with its Zod schemas. */
export function defineRoute<K extends RunnerRouteName>(app: FastifyInstance, name: K, handler: Handler<K>): void {
  const def = RUNNER_ROUTES[name] as RunnerRouteDef;
  app.route({
    method: def.method,
    url: def.path,
    handler: async (request, reply) => {
      const params = def.params ? def.params.parse(request.params ?? {}) : {};
      const query = def.query ? def.query.parse(request.query ?? {}) : {};
      const body = def.body ? def.body.parse(request.body ?? {}) : undefined;
      const ctx = { params, query, body, request, reply } as unknown as RouteContext<K>;
      if (def.stream) {
        await (handler as (c: RouteContext<K>) => Promise<void>)(ctx);
        return reply;
      }
      const result = await (handler as (c: RouteContext<K>) => Promise<unknown>)(ctx);
      if (reply.sent) return reply;
      let output: unknown = result;
      if (def.response) {
        const parsed = def.response.safeParse(result);
        if (!parsed.success) {
          // Our own answer breaks the contract: a server bug, never the client's fault.
          request.log.error({ route: name, issues: parsed.error.issues.slice(0, 5) }, 'réponse non conforme au contrat');
          throw new RunnerError('INTERNAL', 'Réponse du runner non conforme au contrat.');
        }
        output = parsed.data;
      }
      return reply.code(200).header('cache-control', 'no-store').send(output);
    },
  });
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** Constant-time bearer token comparison (hash first: no length leak). */
export function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  return timingSafeEqual(digest(match[1]), digest(expected));
}

/** Uniform error body for every route; never leaks stack traces. */
export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const runnerError = toRunnerError(error);
    if (runnerError.code === 'INTERNAL') {
      request.log.error({ err: error }, 'erreur interne');
    } else if (runnerError.status >= 500) {
      request.log.warn({ code: runnerError.code, reason: runnerError.reason }, runnerError.message);
    }
    if (reply.sent || reply.raw.headersSent) return;
    void reply.code(runnerError.status).header('cache-control', 'no-store').send(toErrorBody(runnerError));
  });
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send(toErrorBody(new RunnerError('NOT_FOUND', 'Route inconnue.')));
  });
}

/** Bearer RUNNER_TOKEN on every /v1 route. */
export function installBearerAuth(app: FastifyInstance, token: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, token)) {
      await reply.code(401).header('www-authenticate', 'Bearer').send(toErrorBody(new RunnerError('UNAUTHORIZED', 'Jeton du runner manquant ou invalide.')));
    }
  });
}

/**
 * Registered after the bearer check. While the runner does not serve its server (token unknown or
 * server retired, lease held by another runner, start-up tasks), every route but `GET /v1/health`
 * answers 503 with the reason (`ENVIRONMENT_UNREGISTERED` + token fingerprint in standby,
 * `ENVIRONMENT_STARTING` while another runner holds the lease or the start-up tasks run).
 */
export function installEnvironmentGuard(app: FastifyInstance, environment: { readonly serving: boolean; notServingError(): RunnerError }): void {
  app.addHook('onRequest', async (request, reply) => {
    if (reply.sent || environment.serving) return;
    if (request.method === 'GET' && request.routeOptions.url === RUNNER_ROUTES.health.path) return;
    const error = environment.notServingError();
    await reply.code(error.status).header('cache-control', 'no-store').header('retry-after', '15').send(toErrorBody(error));
  });
}
