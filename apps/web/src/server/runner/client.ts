import 'server-only';
import {
  RUNNER_CONTRACT_VERSION,
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
import { hashToken } from '@nuera/shared/tokens';
import type { z } from 'zod';
import { promoteRunnerToken } from '@/server/admin/token-rotation';
import { AppError, type AppErrorCode } from '@/server/errors';
import { getRunnerEndpoint, type RunnerEndpoint } from './config';
import { RunnerError, runnerUnavailableMessage } from './errors';

export { proxyRunnerStream, relayGlobalStream, runnerUnavailableStream, type WebChannel, type WebChannelEvent } from './stream';
export { RunnerError, isRunnerUnavailable, runnerUnavailableMessage } from './errors';
export { getRunnerEndpoint, invalidateRunnerEndpoint, type RunnerEndpoint } from './config';

/**
 * Typed client of a runner (private HTTP API, Bearer token of its server). One method per route of
 * `RUNNER_ROUTES` (`client.cloneRepo({ body })`, `client.repoStatus({ params: { projectId } })`…).
 *
 * There is NO global client: every call goes to the server (environment) that holds the resource
 * (`projects.environment_id`), through `scopeOf*()` / `requireEnvironment()` of `@/server/tenancy`,
 * or {@link getRunnerForEnvironment} for code that already knows the server.
 *
 * - Requests and responses are validated with the shared Zod schemas.
 * - Network failures → `RUNNER_UNAVAILABLE` « {nom} ne répond pas : le runner est injoignable. »
 *   (Figma T5; the default server is « VPS-3 »); timeouts → `UPSTREAM`.
 * - Runner error bodies keep their code/message/detail/raw/untouched; the machine-readable
 *   `reason` and `data` stay available on {@link RunnerError}, with the server's `environmentId`.
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

function unavailable(endpoint: RunnerEndpoint, detail: string, cause?: unknown): RunnerError {
  return new RunnerError('RUNNER_UNAVAILABLE', runnerUnavailableMessage(endpoint.name), {
    detail,
    cause,
    environmentId: endpoint.environmentId,
  });
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}
function isTimeoutError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'TimeoutError';
}

/** Low-level call to the runner of `endpoint` (every method of a {@link RunnerClient} uses it). */
export async function callRunner<K extends JsonRunnerRouteName>(
  endpoint: RunnerEndpoint,
  name: K,
  input: RunnerInput<K> | undefined,
  options: RunnerCallOptions = {},
): Promise<RunnerOutput<K>> {
  const route = RUNNER_ROUTES[name] as RunnerRouteDef;
  const environmentId = endpoint.environmentId;
  if (!endpoint.baseUrl || !endpoint.token) {
    throw unavailable(endpoint, endpoint.problem ?? "Le jeton du runner n'est pas configuré côté web.");
  }

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
      environmentId,
    });
  }

  const url = `${endpoint.baseUrl}${buildRunnerPath(route.path, params)}${buildRunnerQuery(query)}`;
  const timeoutMs = options.timeoutMs ?? route.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const send = async (token: string): Promise<Response> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    try {
      return await fetch(url, {
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
        throw new RunnerError('UPSTREAM', "Le runner n'a pas répondu à temps.", {
          detail: `${route.method} ${route.path}`,
          cause: error,
          environmentId,
        });
      }
      throw unavailable(endpoint, `${route.method} ${route.path}`, error);
    }
  };

  let response = await send(endpoint.token);
  // Token rotation in progress: the runner may already use the next token.
  if (response.status === 401 && endpoint.fallbackToken) {
    await response.body?.cancel().catch(() => undefined);
    response = await send(endpoint.fallbackToken);
    // Accepted: the runner restarted with the rotated token, which replaces the old one now
    // (MULTICOMPTE §4). Best effort, never throws; the call itself does not wait for it.
    if (response.ok) void promoteRunnerToken(environmentId, hashToken(endpoint.fallbackToken));
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
        environmentId,
      });
    }
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw unavailable(endpoint, `HTTP ${response.status}`);
    }
    throw new RunnerError('UPSTREAM', 'Réponse inattendue du runner.', { detail: `HTTP ${response.status}`, environmentId });
  }

  if (!route.response) return undefined as RunnerOutput<K>;
  const parsed = route.response.safeParse(json);
  if (!parsed.success) {
    throw new RunnerError('UPSTREAM', 'Réponse du runner non conforme au contrat.', {
      detail: parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')} : ${issue.message}`)
        .join(' ; '),
      environmentId,
    });
  }
  return parsed.data as RunnerOutput<K>;
}

const jsonRouteNames = (Object.keys(RUNNER_ROUTES) as RunnerRouteName[]).filter(
  (name): name is JsonRunnerRouteName => !(RUNNER_ROUTES[name] as RunnerRouteDef).stream,
);

/** A client whose endpoint is resolved at each call (so token rotations and URL changes apply). */
export function createRunnerClient(resolve: () => Promise<RunnerEndpoint>): RunnerClient {
  return Object.fromEntries(
    jsonRouteNames.map((name) => [
      name,
      async (input?: RunnerInput<typeof name>, options?: RunnerCallOptions) => callRunner(await resolve(), name, input, options),
    ]),
  ) as unknown as RunnerClient;
}

const clientsHolder = globalThis as unknown as { __nueraRunnerClients?: Map<string, RunnerClient> };

/**
 * Client of the runner of one server. Only call it with an environment id that comes out of a
 * scoped query (`scopeOf*()`, `requireEnvironment()`, the caller of an internal route): it does
 * not check who may use the server.
 */
export function getRunnerForEnvironment(environmentId: string): RunnerClient {
  clientsHolder.__nueraRunnerClients ??= new Map();
  let client = clientsHolder.__nueraRunnerClients.get(environmentId);
  if (!client) {
    client = createRunnerClient(() => getRunnerEndpoint(environmentId));
    clientsHolder.__nueraRunnerClients.set(environmentId, client);
  }
  return client;
}

// ---------------------------------------------------------------------------------------------
// Contract version (MULTICOMPTE §4): a route newer than the runner's contract is politely refused.
// ---------------------------------------------------------------------------------------------

const CONTRACT_TTL_MS = 60_000;
const contractHolder = globalThis as unknown as { __nueraRunnerContracts?: Map<string, { version: number; expiresAt: number }> };

/** `contractVersion` of the server's runner (`/v1/health`; absent = 1), cached 60 s. */
export async function getRunnerContractVersion(environmentId: string): Promise<number> {
  contractHolder.__nueraRunnerContracts ??= new Map();
  const cached = contractHolder.__nueraRunnerContracts.get(environmentId);
  if (cached && cached.expiresAt > Date.now()) return cached.version;
  const health = await getRunnerForEnvironment(environmentId).health(undefined, { timeoutMs: 5_000 });
  const version = health.contractVersion ?? 1;
  contractHolder.__nueraRunnerContracts.set(environmentId, { version, expiresAt: Date.now() + CONTRACT_TTL_MS });
  return version;
}

/** Forgets the cached contract versions (after a runner update, in tests). */
export function invalidateRunnerContract(environmentId?: string): void {
  if (environmentId) contractHolder.__nueraRunnerContracts?.delete(environmentId);
  else contractHolder.__nueraRunnerContracts?.clear();
}

/**
 * Refuses an action that needs a newer runner: AppError UPSTREAM « Le serveur {nom} doit être mis à
 * jour pour cette action. » (reason RUNNER_OUTDATED). An unreachable runner answers T5 as usual.
 */
export async function requireRunnerContract(environmentId: string, required: number = RUNNER_CONTRACT_VERSION): Promise<void> {
  const version = await getRunnerContractVersion(environmentId);
  if (version >= required) return;
  const { name } = await getRunnerEndpoint(environmentId);
  throw new AppError('UPSTREAM', `Le serveur ${name} doit être mis à jour pour cette action.`, {
    reason: 'RUNNER_OUTDATED',
    detail: `Contrat du runner : ${version} ; requis : ${required}.`,
  });
}
