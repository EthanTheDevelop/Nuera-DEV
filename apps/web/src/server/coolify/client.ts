import 'server-only';
import { z } from 'zod';
import { providerMessageOf } from '@/server/integrations/redact';

/**
 * GET-only Coolify v4 API client (research §3). There is deliberately no method that can deploy,
 * restart, write or delete: Nuera Dev only reads Coolify (« Production hors de portée »).
 */

export type CoolifyErrorKind =
  | 'unauthorized' // 401 Unauthenticated. — unknown, expired, revoked or paused token
  | 'invalid_token' // 400 Invalid token. — the token's user left its team
  | 'missing_ability' // 403 Missing required permissions: …
  | 'scoped_route' // 403 limited to selected projects… (expected for /team with a scoped token)
  | 'api_disabled' // 403 API is disabled.
  | 'ip_not_allowed' // 403 You are not allowed to access the API.
  | 'forbidden'
  | 'not_found'
  | 'method_changed' // 405 This endpoint has changed to a POST request.
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'invalid_response';

export class CoolifyError extends Error {
  readonly kind: CoolifyErrorKind;
  readonly status: number | null;
  readonly providerMessage: string | undefined;
  readonly ms: number;

  constructor(kind: CoolifyErrorKind, message: string, options: { status?: number | null; providerMessage?: string; ms?: number } = {}) {
    super(message);
    this.name = 'CoolifyError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.providerMessage = options.providerMessage;
    this.ms = options.ms ?? 0;
  }

  /** Credential refused: « à reconnecter » (definitive, no hysteresis). */
  get isCredentialError(): boolean {
    return this.kind === 'unauthorized' || this.kind === 'invalid_token';
  }

  /** Unreachable / overloaded: transient. */
  get isTransient(): boolean {
    return ['timeout', 'network', 'server_error', 'rate_limited'].includes(this.kind);
  }
}

export interface CoolifyClientOptions {
  /** Instance URL (https://coolify.nuera.studio) — `/api/v1` is appended. */
  baseUrl: string;
  token?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface CoolifyCall<T> {
  data: T;
  status: number;
  ms: number;
}

export const coolifyApplicationSchema = z
  .object({
    uuid: z.string(),
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    fqdn: z.string().nullable().optional(),
    git_repository: z.string().nullable().optional(),
    git_branch: z.string().nullable().optional(),
    git_commit_sha: z.string().nullable().optional(),
    git_full_url: z.string().nullable().optional(),
    build_pack: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    environment_id: z.number().nullable().optional(),
    destination_id: z.number().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    health_check_enabled: z.boolean().nullable().optional(),
    health_check_path: z.string().nullable().optional(),
  })
  .loose();
export type CoolifyApplication = z.infer<typeof coolifyApplicationSchema>;

export const coolifyDeploymentSchema = z
  .object({
    id: z.number().optional(),
    deployment_uuid: z.string().nullable().optional(),
    application_id: z.union([z.number(), z.string()]).nullable().optional(),
    application_name: z.string().nullable().optional(),
    pull_request_id: z.number().nullable().optional(),
    commit: z.string().nullable().optional(),
    commit_message: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    is_webhook: z.boolean().nullable().optional(),
    is_api: z.boolean().nullable().optional(),
    rollback: z.boolean().nullable().optional(),
    deployment_url: z.string().nullable().optional(),
    server_name: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
  })
  .loose();
export type CoolifyDeployment = z.infer<typeof coolifyDeploymentSchema>;

export const coolifyResourceSchema = z
  .object({
    uuid: z.string(),
    name: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    environment_id: z.number().nullable().optional(),
  })
  .loose();

export const coolifyProjectSchema = z
  .object({ id: z.number().optional(), uuid: z.string(), name: z.string().nullable().optional() })
  .loose();

export const coolifyEnvironmentSchema = z
  .object({ id: z.number().optional(), uuid: z.string().optional(), name: z.string(), project_id: z.number().optional() })
  .loose();

export const coolifyTeamSchema = z.object({ id: z.number().optional(), name: z.string() }).loose();

function classify(status: number, message: string | undefined): CoolifyErrorKind {
  const text = (message ?? '').toLowerCase();
  if (status === 401) return 'unauthorized';
  if (status === 400 && text.includes('invalid token')) return 'invalid_token';
  if (status === 403) {
    if (text.includes('missing required permissions')) return 'missing_ability';
    if (text.includes('limited to selected')) return 'scoped_route';
    if (text.includes('api is disabled')) return 'api_disabled';
    if (text.includes('not allowed to access the api')) return 'ip_not_allowed';
    return 'forbidden';
  }
  if (status === 404) return 'not_found';
  if (status === 405) return 'method_changed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'invalid_response';
}

const KIND_MESSAGES: Record<CoolifyErrorKind, string> = {
  unauthorized: 'Coolify refuse le jeton.',
  invalid_token: "Coolify refuse le jeton : son utilisateur n'appartient plus à l'équipe.",
  missing_ability: "Le jeton Coolify n'a pas les droits nécessaires.",
  scoped_route: 'Ce jeton est limité à des environnements choisis.',
  api_disabled: "L'API est désactivée dans Coolify.",
  ip_not_allowed: "L'adresse de VPS-3 n'est pas autorisée par Coolify.",
  forbidden: "Coolify refuse l'accès.",
  not_found: 'Adresse introuvable sur Coolify.',
  method_changed: 'Requête refusée par Coolify (méthode).',
  rate_limited: 'Coolify limite les requêtes : réessayez dans un instant.',
  server_error: 'Coolify a renvoyé une erreur serveur.',
  timeout: 'Coolify ne répond pas (délai dépassé).',
  network: 'Coolify est injoignable.',
  invalid_response: 'Réponse inattendue de Coolify.',
};

export function normalizeCoolifyBaseUrl(value: string): string {
  const url = new URL(value.trim());
  url.hash = '';
  url.search = '';
  return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/api(\/v1)?$/, '')}`;
}

export function createCoolifyClient(options: CoolifyClientOptions) {
  const base = normalizeCoolifyBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function get(path: string, init: { auth?: boolean; text?: boolean } = {}): Promise<CoolifyCall<unknown>> {
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.auth !== false && options.token) headers.Authorization = `Bearer ${options.token}`;
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new CoolifyError(timedOut ? 'timeout' : 'network', KIND_MESSAGES[timedOut ? 'timeout' : 'network'], { ms: ms() });
    }
    const raw = await response.text().catch(() => '');
    let body: unknown = raw;
    if ((response.headers.get('content-type') ?? '').includes('json') && raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    if (!response.ok) {
      const providerMessage = providerMessageOf(body);
      const kind = response.status >= 300 && response.status < 400 ? 'invalid_response' : classify(response.status, providerMessage);
      throw new CoolifyError(kind, KIND_MESSAGES[kind], {
        status: response.status,
        ...(providerMessage ? { providerMessage } : {}),
        ms: ms(),
      });
    }
    return { data: init.text ? raw : body, status: response.status, ms: ms() };
  }

  async function parsed<T>(path: string, schema: z.ZodType<T>): Promise<CoolifyCall<T>> {
    const call = await get(path);
    const result = schema.safeParse(call.data);
    if (!result.success) throw new CoolifyError('invalid_response', KIND_MESSAGES.invalid_response, { status: call.status, ms: call.ms });
    return { ...call, data: result.data };
  }

  return {
    baseUrl: base,
    /** `GET /api/health` (no token) → text `OK`. */
    async health(): Promise<CoolifyCall<string>> {
      const call = await get('/api/health', { auth: false, text: true });
      return { ...call, data: String(call.data).trim() };
    },
    /** `GET /api/v1/version` → « v4.6.0 » (proves the token has `read`). */
    async version(): Promise<CoolifyCall<string>> {
      const call = await get('/api/v1/version', { text: true });
      return { ...call, data: String(call.data).trim().replace(/^"|"$/g, '') };
    },
    /** `GET /api/v1/team` — 403 `scoped_route` for a scoped token (4.6). */
    team: () => parsed('/api/v1/team', coolifyTeamSchema),
    applications: () => parsed('/api/v1/applications', z.array(coolifyApplicationSchema)),
    application: (uuid: string) => parsed(`/api/v1/applications/${encodeURIComponent(uuid)}`, coolifyApplicationSchema),
    /** `GET /api/v1/deployments/applications/{uuid}` → `{ count, deployments }` (the spec is wrong, research §3.2). */
    async deploymentsForApplication(uuid: string, options: { skip?: number; take?: number } = {}) {
      const query = new URLSearchParams({ skip: String(options.skip ?? 0), take: String(Math.min(options.take ?? 10, 50)) });
      const call = await get(`/api/v1/deployments/applications/${encodeURIComponent(uuid)}?${query}`);
      const asObject = z.object({ count: z.number().optional(), deployments: z.array(coolifyDeploymentSchema) }).safeParse(call.data);
      if (asObject.success) return { ...call, data: { count: asObject.data.count ?? asObject.data.deployments.length, deployments: asObject.data.deployments } };
      const asArray = z.array(coolifyDeploymentSchema).safeParse(call.data);
      if (asArray.success) return { ...call, data: { count: asArray.data.length, deployments: asArray.data } };
      throw new CoolifyError('invalid_response', KIND_MESSAGES.invalid_response, { status: call.status, ms: call.ms });
    },
    resources: () => parsed('/api/v1/resources', z.array(coolifyResourceSchema)),
    projects: () => parsed('/api/v1/projects', z.array(coolifyProjectSchema)),
    environments: (projectUuid: string) =>
      parsed(`/api/v1/projects/${encodeURIComponent(projectUuid)}/environments`, z.array(coolifyEnvironmentSchema)),
  };
}

export type CoolifyClient = ReturnType<typeof createCoolifyClient>;
