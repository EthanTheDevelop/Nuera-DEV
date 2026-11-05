import 'server-only';
import {
  RUNNER_ROUTES,
  RunnerErrorBodySchema,
  buildRunnerPath,
  buildRunnerQuery,
  type JsonRunnerRouteName,
  type RunnerErrorCode,
  type RunnerRouteDef,
  type RunnerRouteName,
  type RunnerRoutes,
} from '@nuera/shared/runner';
import type { z } from 'zod';
import type { AppErrorCode } from '@/server/errors';
import { getRunnerConfig } from './config';
import { RunnerError } from './errors';

export { proxyRunnerStream } from './stream';
export { RunnerError, isRunnerUnavailable } from './errors';

/**
 * Typed client of the runner (private HTTP API, Bearer RUNNER_TOKEN). One method per route of
 * `RUNNER_ROUTES` (`runner.cloneRepo({ body })`, `runner.repoStatus({ params: { projectId } })`…).
 *
 * - Requests and responses are validated with the shared Zod schemas.
 * - Network failures → AppError `RUNNER_UNAVAILABLE` (Figma T5); timeouts → `UPSTREAM`.
 * - Runner error bodies keep their code/message/detail/raw/untouched; the machine-readable
 *   `reason` and `data` stay available on {@link RunnerError}.
 */

export interface RunnerCallOptions {
  signal?: AbortSignal;
  /** Overrides the route's default timeout (ms). */
  timeoutMs?: number;
}

type SchemaInput<S> = S extends z.ZodType ? z.input<S> : never;
type SchemaOutput<S> = S extends z.ZodType ? z.output<S> : never;
type BodyPart<B> = {} extends B ? { body?: B } : { body: B };

export type RunnerInput<K extends RunnerRouteName> = (RunnerRoutes[K] extends { params: infer P }
  ? { params: SchemaInput<P> }
  : { params?: undefined }) &
  (RunnerRoutes[K] extends { query: infer Q } ? { query?: SchemaInput<Q> } : { query?: undefined }) &
  (RunnerRoutes[K] extends { body: infer B } ? BodyPart<SchemaInput<B>> : { body?: undefined });

export type RunnerOutput<K extends RunnerRouteName> = RunnerRoutes[K] extends { response: infer R }
  ? SchemaOutput<R>
  : never;

type RunnerMethod<K extends JsonRunnerRouteName> = {} extends RunnerInput<K>
  ? (input?: RunnerInput<K>, options?: RunnerCallOptions) => Promise<RunnerOutput<K>>
  : (input: RunnerInput<K>, options?: RunnerCallOptions) => Promise<RunnerOutput<K>>;

export type RunnerClient = { [K in JsonRunnerRouteName]: RunnerMethod<K> };

const DEFAULT_TIMEOUT_MS = 15_000;

const RUNNER_TO_APP_CODE: Record<RunnerErrorCode, AppErrorCode> = {
  UNAUTHORIZED: 'RUNNER_UNAVAILABLE',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  UPSTREAM: 'UPSTREAM',
  INTERNAL: 'UPSTREAM',
};

function unavailable(detail: string, cause?: unknown): RunnerError {
  return new RunnerError('RUNNER_UNAVAILABLE', 'VPS-3 ne répond pas : le runner est injoignable.', { detail, cause });
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}
function isTimeoutError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'TimeoutError';
}

/** Low-level call used by every method of {@link runner}. */
export async function callRunner<K extends JsonRunnerRouteName>(
  name: K,
  input: RunnerInput<K> | undefined,
  options: RunnerCallOptions = {},
): Promise<RunnerOutput<K>> {
  const route = RUNNER_ROUTES[name] as RunnerRouteDef;
  const { baseUrl, token } = getRunnerConfig();
  if (!token) throw unavailable("RUNNER_TOKEN n'est pas configuré côté web.");

  const params = (input as { params?: Record<string, unknown> } | undefined)?.params;
  const rawQuery = (input as { query?: Record<string, unknown> } | undefined)?.query;
  const rawBody = (input as { body?: unknown } | undefined)?.body;

  let query: Record<string, unknown> | undefined;
  let body: unknown;
  try {
    if (route.params) route.params.parse(params);
    query = route.query && rawQuery !== undefined ? (route.query.parse(rawQuery) as Record<string, unknown>) : rawQuery;
    body = route.body ? route.body.parse(rawBody ?? {}) : undefined;
  } catch (error) {
    throw new RunnerError('VALIDATION', 'Requête invalide pour le runner.', {
      detail: error instanceof Error ? error.message.slice(0, 500) : undefined,
      cause: error,
    });
  }

  const url = `${baseUrl}${buildRunnerPath(route.path, params)}${buildRunnerQuery(query)}`;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? route.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(url, {
      method: route.method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (options.signal?.aborted && isAbortError(error)) throw error;
    if (isTimeoutError(error) || timeoutSignal.aborted) {
      throw new RunnerError('UPSTREAM', "Le runner n'a pas répondu à temps.", { detail: `${route.method} ${route.path}`, cause: error });
    }
    throw unavailable(`${route.method} ${route.path}`, error);
  }

  const text = await response.text().catch(() => '');
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const parsed = RunnerErrorBodySchema.safeParse(json);
    if (parsed.success) {
      const e = parsed.data.error;
      const code = RUNNER_TO_APP_CODE[e.code];
      throw new RunnerError(code, e.code === 'UNAUTHORIZED' ? 'Le runner a refusé le jeton du serveur web.' : e.message, {
        status: code === 'RUNNER_UNAVAILABLE' ? 503 : response.status,
        detail: e.detail,
        raw: e.raw,
        untouched: e.untouched,
        reason: e.reason,
        data: e.data,
      });
    }
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw unavailable(`HTTP ${response.status}`);
    }
    throw new RunnerError('UPSTREAM', 'Réponse inattendue du runner.', { detail: `HTTP ${response.status}` });
  }

  if (!route.response) return undefined as RunnerOutput<K>;
  const parsed = route.response.safeParse(json);
  if (!parsed.success) {
    throw new RunnerError('UPSTREAM', 'Réponse du runner non conforme au contrat.', {
      detail: parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')} : ${issue.message}`)
        .join(' ; '),
    });
  }
  return parsed.data as RunnerOutput<K>;
}

const jsonRouteNames = (Object.keys(RUNNER_ROUTES) as RunnerRouteName[]).filter(
  (name): name is JsonRunnerRouteName => !(RUNNER_ROUTES[name] as RunnerRouteDef).stream,
);

/** The runner client: one typed method per JSON route. */
export const runner: RunnerClient = Object.fromEntries(
  jsonRouteNames.map((name) => [
    name,
    (input?: RunnerInput<typeof name>, options?: RunnerCallOptions) => callRunner(name, input, options),
  ]),
) as unknown as RunnerClient;
