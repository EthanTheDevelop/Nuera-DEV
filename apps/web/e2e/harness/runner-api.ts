/**
 * TEST-ONLY — typed calls to a stack's runner (Bearer RUNNER_TOKEN), for seeds and e2e tests:
 *
 *   const api = runnerApi(state);
 *   const session = await api('createSession', { body: { projectId, worktree: { mode: 'new', branch: 'feature/x' } } });
 *   await api('sendInstruction', { params: { sessionId: session.id }, body: { text: 'scenario:remise …' } });
 *
 * Same contract as the web client (`RUNNER_ROUTES` of @nuera/shared/runner): inputs are parsed
 * with the route schemas before sending, responses parsed with the response schema.
 */
import {
  RUNNER_ROUTES,
  buildRunnerPath,
  buildRunnerQuery,
  type JsonRunnerRouteName,
  type RunnerRouteDef,
  type RunnerRoutes,
} from '@nuera/shared/runner';
import type { z } from 'zod';

type SchemaInput<S> = S extends z.ZodType ? z.input<S> : never;
type SchemaOutput<S> = S extends z.ZodType ? z.output<S> : never;
// oxlint-disable-next-line typescript/no-empty-object-type
type BodyPart<B> = {} extends B ? { body?: B } : { body: B };

export type RunnerApiInput<K extends JsonRunnerRouteName> = (RunnerRoutes[K] extends { params: infer P } ? { params: SchemaInput<P> } : { params?: undefined }) &
  (RunnerRoutes[K] extends { query: infer Q } ? { query?: SchemaInput<Q> } : { query?: undefined }) &
  (RunnerRoutes[K] extends { body: infer B } ? BodyPart<SchemaInput<B>> : { body?: undefined });

export type RunnerApiOutput<K extends JsonRunnerRouteName> = RunnerRoutes[K] extends { response: infer R } ? SchemaOutput<R> : never;

export type RunnerApi = <K extends JsonRunnerRouteName>(route: K, input?: RunnerApiInput<K>, options?: { timeoutMs?: number }) => Promise<RunnerApiOutput<K>>;

/** Error body of the runner (`{ error: { code, message, reason, raw, untouched, data } }`). */
export class RunnerApiError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    readonly body: { code?: string; message?: string; reason?: string; detail?: string; raw?: string; untouched?: string; data?: unknown } | null,
  ) {
    super(`${route} → HTTP ${status}${body?.reason ? ` (${body.reason})` : ''} : ${body?.message ?? 'erreur'}${body?.detail ? ` — ${body.detail}` : ''}`);
    this.name = 'RunnerApiError';
  }
}

export function createRunnerApi(target: { runnerUrl: string; token: string }): RunnerApi {
  return async (route, input, options = {}) => {
    const def = RUNNER_ROUTES[route] as RunnerRouteDef;
    const raw = (input ?? {}) as { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };
    if (def.params) def.params.parse(raw.params);
    const query = def.query && raw.query !== undefined ? (def.query.parse(raw.query) as Record<string, unknown>) : raw.query;
    const body = def.body ? def.body.parse(raw.body ?? {}) : undefined;
    const url = `${target.runnerUrl}${buildRunnerPath(def.path, raw.params)}${buildRunnerQuery(query)}`;
    const response = await fetch(url, {
      method: def.method,
      headers: {
        authorization: `Bearer ${target.token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? Math.max(def.timeoutMs ?? 0, 60_000)),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const error = (json as { error?: RunnerApiError['body'] } | null)?.error ?? null;
      throw new RunnerApiError(route, response.status, error ?? { message: text.slice(0, 500) });
    }
    return (def.response ? def.response.parse(json) : json) as never;
  };
}
