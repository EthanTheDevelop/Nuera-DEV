import 'server-only';
import { projects } from '@nuera/db/schema';
import { eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import {
  applyHysteresis,
  newCheckId,
  pushHistory,
  startTimer,
  EXPIRING_THRESHOLD_MS,
  type CheckStep,
  type CheckTrigger,
  type IntegrationCheck,
} from '@/server/integrations/model';
import { applyHealthTransition, healthOfIntegrationStatus } from '@/server/integrations/transitions';
import { probeMcpServer } from '@/server/mcp/probe';
import { audit } from '@/server/security/audit';
import {
  CoolifyError,
  createCoolifyClient,
  normalizeCoolifyBaseUrl,
  type CoolifyApplication,
  type CoolifyDeployment,
} from './client';
import {
  coolifyConfigSchema,
  deleteCoolify,
  getStoredCoolify,
  readCoolifyToken,
  updateCoolify,
  upsertCoolify,
  type CoolifyConfig,
} from './store';

/**
 * Coolify integration (research §3): one read-only token (« Nuera Dev · Développement »), validated
 * with GETs only, stored ENCRYPTED, never echoed back. The same token authenticates Claude's Coolify
 * MCP server through the headers helper (no secret in session files).
 */

export { CoolifyError, createCoolifyClient, normalizeCoolifyBaseUrl } from './client';
export type { CoolifyApplication, CoolifyDeployment, CoolifyClient } from './client';

type DbStatus = 'connected' | 'expiring' | 'expired' | 'error';

export const COOLIFY_IMPACT = "Les sessions n'ont plus accès aux environnements de développement.";
const PRODUCTION_PATTERN = /^(prod|production|live)([-_ ].*)?$/i;
const CHECK_MIN_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------------------------
// Public view (no secret)
// ---------------------------------------------------------------------------------------------

export interface CoolifySettingsView {
  configured: boolean;
  status: 'not_configured' | DbStatus | 'pending' | 'disconnected';
  baseUrl: string | null;
  /** « jeton n°67 » — never the token itself. */
  tokenFingerprint: string | null;
  scope: CoolifyConfig['scope'] | null;
  teamName: string | null;
  abilities: string[];
  version: string | null;
  mcpEnabled: boolean | null;
  visibleEnvironments: CoolifyConfig['visibleEnvironments'];
  productionVisible: boolean;
  warnings: string[];
  declaredExpiresAt: string | null;
  connectedAt: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  failingSince: string | null;
  lastError: string | null;
  reason: string | null;
  /** Where to create a new token (« Keys & Tokens »). */
  tokensUrl: string | null;
  lastCheck: IntegrationCheck | null;
  history: CoolifyConfig['history'];
}

export function tokenFingerprint(prefix: string | null): string | null {
  return prefix ? `jeton n°${prefix}` : null;
}

function tokensUrl(baseUrl: string): string {
  return `${baseUrl}/security/api-tokens`;
}

export async function getCoolifySettings(): Promise<CoolifySettingsView> {
  const stored = await getStoredCoolify();
  if (!stored) {
    return {
      configured: false,
      status: 'not_configured',
      baseUrl: null,
      tokenFingerprint: null,
      scope: null,
      teamName: null,
      abilities: [],
      version: null,
      mcpEnabled: null,
      visibleEnvironments: [],
      productionVisible: false,
      warnings: [],
      declaredExpiresAt: null,
      connectedAt: null,
      lastCheckedAt: null,
      lastSuccessAt: null,
      failingSince: null,
      lastError: null,
      reason: null,
      tokensUrl: null,
      lastCheck: null,
      history: [],
    };
  }
  const { row, config } = stored;
  return {
    configured: true,
    status: row.status as CoolifySettingsView['status'],
    baseUrl: config.baseUrl,
    tokenFingerprint: tokenFingerprint(config.tokenIdPrefix),
    scope: config.scope,
    teamName: config.teamName,
    abilities: config.abilities,
    version: config.version,
    mcpEnabled: config.mcpEnabled,
    visibleEnvironments: config.visibleEnvironments,
    productionVisible: config.productionVisible,
    warnings: config.warnings,
    declaredExpiresAt: config.declaredExpiresAt,
    connectedAt: config.connectedAt,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    failingSince: config.failingSince,
    lastError: row.lastError,
    reason: config.lastCheck?.result.reason ?? null,
    tokensUrl: tokensUrl(config.baseUrl),
    lastCheck: config.lastCheck,
    history: config.history,
  };
}

/** Decrypted credential for server-side use only (MCP headers helper, API reads). */
export async function getCoolifyCredential(): Promise<{ baseUrl: string; token: string } | null> {
  const stored = await getStoredCoolify();
  if (!stored) return null;
  return { baseUrl: stored.config.baseUrl, token: readCoolifyToken(stored.row) };
}

// ---------------------------------------------------------------------------------------------
// Token validation (D2 « Reconnecter ») — GET only
// ---------------------------------------------------------------------------------------------

const allowedBaseUrl = (value: string) => {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
    return url.protocol === 'http:' && loopback && process.env.NODE_ENV !== 'production';
  } catch {
    return false;
  }
};

export const reconnectCoolifyInputSchema = z.object({
  /** Required on the first connection; reuses the stored URL otherwise. */
  baseUrl: z
    .string()
    .trim()
    .max(300)
    .refine(allowedBaseUrl, 'adresse https de Coolify attendue')
    .optional(),
  token: z
    .string()
    .trim()
    .min(10, 'jeton trop court')
    .max(500)
    .regex(/^[\x21-\x7e]+$/, 'jeton invalide'),
  /** Expiry chosen in Coolify (7, 30, 60, 90 days, 1 year or never → null). */
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  /** Explicit override when the token can also see production environments (read-only). */
  allowProductionVisible: z.boolean().optional(),
});
export type ReconnectCoolifyInput = z.input<typeof reconnectCoolifyInputSchema>;

export interface CoolifyValidation {
  ok: boolean;
  steps: CheckStep[];
  version: string | null;
  scope: CoolifyConfig['scope'];
  teamName: string | null;
  abilities: string[];
  abilitiesSource: CoolifyConfig['abilitiesSource'];
  mcpEnabled: boolean | null;
  mcpToolCount: number | null;
  visibleEnvironments: CoolifyConfig['visibleEnvironments'];
  productionVisible: boolean;
  warnings: string[];
  /** French reason when `ok` is false. */
  reason: string | null;
  /** Credential refused (vs. Coolify unreachable). */
  credentialRefused: boolean;
}

function stepFromCoolifyError(name: string, error: unknown): CheckStep {
  if (error instanceof CoolifyError) {
    return {
      name,
      ok: false,
      ms: error.ms,
      ...(error.status ? { httpStatus: error.status } : {}),
      providerMessage: error.providerMessage ?? error.message,
    };
  }
  return { name, ok: false, ms: 0, providerMessage: 'erreur inattendue' };
}

/** Infers abilities from the tools the Coolify MCP server lists for this token (research §3.6). */
export function inferAbilitiesFromTools(tools: string[]): { abilities: string[]; write: boolean } {
  const abilities = new Set<string>(['read']);
  if (tools.includes('get_env_values')) abilities.add('read:sensitive');
  if (tools.some((tool) => ['deploy', 'control', 'cancel_deployment', 'rollback_application'].includes(tool))) abilities.add('deploy');
  const write = tools.some((tool) => /^(manage|create|delete|update)_/.test(tool));
  if (write) abilities.add('write');
  return { abilities: [...abilities], write };
}

export async function validateCoolifyToken(input: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<CoolifyValidation> {
  const client = createCoolifyClient({ baseUrl: input.baseUrl, token: input.token, ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
  const steps: CheckStep[] = [];
  const result: CoolifyValidation = {
    ok: false,
    steps,
    version: null,
    scope: 'unknown',
    teamName: null,
    abilities: [],
    abilitiesSource: 'unknown',
    mcpEnabled: null,
    mcpToolCount: null,
    visibleEnvironments: [],
    productionVisible: false,
    warnings: [],
    reason: null,
    credentialRefused: false,
  };

  // 1. Liveness (no token)
  try {
    const health = await client.health();
    steps.push({ name: 'GET /api/health', ok: true, ms: health.ms, httpStatus: health.status, providerMessage: health.data.slice(0, 40) });
  } catch (error) {
    steps.push(stepFromCoolifyError('GET /api/health', error));
    result.reason = "Coolify injoignable : vérifiez l'adresse.";
    return result;
  }

  // 2. Token + `read` ability
  try {
    const version = await client.version();
    steps.push({ name: 'GET /api/v1/version', ok: true, ms: version.ms, httpStatus: version.status, providerMessage: version.data.slice(0, 40) });
    result.version = version.data.slice(0, 40) || null;
    result.abilities = ['read'];
    result.abilitiesSource = 'rest';
  } catch (error) {
    steps.push(stepFromCoolifyError('GET /api/v1/version', error));
    if (error instanceof CoolifyError) {
      result.credentialRefused = error.isCredentialError || error.kind === 'missing_ability';
      result.reason = error.message;
    } else {
      result.reason = 'Réponse inattendue de Coolify.';
    }
    return result;
  }

  // 3. Scope: whole team (200) or selected environments (403 scoped, Coolify ≥ 4.6)
  try {
    const team = await client.team();
    steps.push({ name: 'GET /api/v1/team', ok: true, ms: team.ms, httpStatus: team.status });
    result.scope = 'team';
    result.teamName = team.data.name;
  } catch (error) {
    steps.push(stepFromCoolifyError('GET /api/v1/team', error));
    if (error instanceof CoolifyError && error.kind === 'scoped_route') result.scope = 'scoped';
  }

  // 4. Visible environments → refuse production unless explicitly accepted
  try {
    const list = await client.projects();
    steps.push({ name: 'GET /api/v1/projects', ok: true, ms: list.ms, httpStatus: list.status });
    for (const project of list.data.slice(0, 30)) {
      try {
        const envs = await client.environments(project.uuid);
        for (const env of envs.data) {
          result.visibleEnvironments.push({ project: project.name ?? project.uuid, environment: env.name });
        }
      } catch (error) {
        steps.push(stepFromCoolifyError(`GET /api/v1/projects/${project.uuid}/environments`, error));
      }
    }
    result.productionVisible = result.visibleEnvironments.some((env) => PRODUCTION_PATTERN.test(env.environment));
  } catch (error) {
    steps.push(stepFromCoolifyError('GET /api/v1/projects', error));
  }

  // 5. MCP tools/list → abilities (tools are filtered by the token's abilities)
  const mcp = await probeMcpServer({
    url: `${client.baseUrl}/mcp`,
    headers: { Authorization: `Bearer ${input.token}` },
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  steps.push(...mcp.steps.map((step) => ({ ...step, name: `MCP · ${step.name}` })));
  if (mcp.outcome === 'ok') {
    result.mcpEnabled = true;
    result.mcpToolCount = mcp.tools.length;
    const inferred = inferAbilitiesFromTools(mcp.tools);
    result.abilities = inferred.abilities;
    result.abilitiesSource = 'mcp_tools';
    if (inferred.write) {
      result.reason = 'Ce jeton peut modifier Coolify (droit write) : créez un jeton limité à read et read:sensitive.';
      result.credentialRefused = true;
      return result;
    }
    if (inferred.abilities.includes('deploy')) {
      result.warnings.push('Ce jeton peut déployer : ces outils restent bloqués pour Claude par Nuera Dev.');
    }
  } else if (mcp.outcome === 'not_found') {
    result.mcpEnabled = false;
    result.warnings.push("Le serveur MCP de Coolify est désactivé sur cette instance : Claude n'y aura pas accès.");
  } else if (mcp.outcome === 'forbidden') {
    result.mcpEnabled = false;
    result.warnings.push('Le serveur MCP est désactivé pour cette équipe Coolify.');
  } else {
    result.warnings.push("Le serveur MCP de Coolify n'a pas pu être vérifié.");
  }
  if (mcp.outcome !== 'ok') {
    // write / deploy / root cannot be ruled out without the tool list: the headers helper keeps the
    // token away from Claude until a successful MCP test (mcp/headers.ts, coolifyTokenRefusal).
    result.warnings.push(
      "Droits du jeton non vérifiés sans le serveur MCP : Claude ne l'utilisera qu'après un test réussi du serveur MCP Coolify.",
    );
  }
  if (!result.abilities.includes('read:sensitive')) {
    result.warnings.push(
      result.abilitiesSource === 'mcp_tools'
        ? 'Sans read:sensitive, les journaux et les valeurs des variables restent masqués.'
        : "Le droit read:sensitive (journaux, variables) n'a pas pu être vérifié.",
    );
  }
  result.ok = true;
  return result;
}

/** D2 « Reconnecter »: validates (GET only), stores encrypted, audits; never returns the token. */
export async function reconnectCoolify(
  input: ReconnectCoolifyInput,
  options: { actorUserId?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<{ settings: CoolifySettingsView; validation: Omit<CoolifyValidation, 'credentialRefused'> }> {
  const data = reconnectCoolifyInputSchema.parse(input);
  const stored = await getStoredCoolify();
  const rawBase = data.baseUrl ?? stored?.config.baseUrl;
  if (!rawBase) throw new AppError('VALIDATION', 'Adresse de Coolify requise.', { detail: 'Exemple : https://coolify.nuera.studio' });
  const baseUrl = normalizeCoolifyBaseUrl(rawBase);
  const validation = await validateCoolifyToken({ baseUrl, token: data.token, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  const { credentialRefused, ...publicValidation } = validation;
  if (!validation.ok) {
    throw new AppError(credentialRefused ? 'VALIDATION' : 'UPSTREAM', validation.reason ?? 'Jeton Coolify refusé.', {
      untouched: stored ? 'Le jeton précédent est conservé.' : "Aucun jeton n'a été enregistré.",
      raw: validation.steps.map((step) => `${step.name} → ${step.httpStatus ?? '—'} ${step.providerMessage ?? ''}`.trim()).join('\n'),
    });
  }
  if (validation.productionVisible && !data.allowProductionVisible) {
    throw new AppError('VALIDATION', 'Ce jeton voit aussi des environnements de production.', {
      detail: "Créez un jeton limité aux environnements de développement (ou à l'équipe Développement).",
      untouched: stored ? 'Le jeton précédent est conservé.' : "Aucun jeton n'a été enregistré.",
    });
  }
  const now = new Date();
  const prefix = /^(\d+)\|/.exec(data.token)?.[1] ?? null;
  const declaredExpiresAt = data.expiresAt === undefined ? null : data.expiresAt;
  const setupCheck: IntegrationCheck = {
    id: newCheckId(),
    target: 'coolify',
    trigger: 'setup',
    startedAt: now.toISOString(),
    durationMs: validation.steps.reduce((sum, step) => sum + step.ms, 0),
    steps: validation.steps,
    result: { status: 'connected' },
  };
  const config: CoolifyConfig = coolifyConfigSchema.parse({
    baseUrl,
    tokenIdPrefix: prefix,
    declaredExpiresAt,
    scope: validation.scope,
    teamName: validation.teamName,
    abilities: validation.abilities,
    abilitiesSource: validation.abilitiesSource,
    version: validation.version,
    mcpEnabled: validation.mcpEnabled,
    mcpToolCount: validation.mcpToolCount,
    visibleEnvironments: validation.visibleEnvironments,
    productionVisible: validation.productionVisible,
    warnings: validation.warnings,
    connectedAt: now.toISOString(),
    consecutiveFailures: 0,
    failingSince: null,
    lastCheck: setupCheck,
    history: pushHistory(stored?.config.history, setupCheck),
  });
  const status = expiryStatus(declaredExpiresAt, now) ?? 'connected';
  const previous = (stored?.row.status as DbStatus | undefined) ?? 'connected';
  await upsertCoolify({ config, token: data.token, status, checkedAt: now });
  await audit({
    action: stored ? 'integration.coolify.reconnected' : 'integration.coolify.connected',
    summary: `${stored ? 'Coolify reconnecté' : 'Coolify connecté'} (${tokenFingerprint(prefix) ?? 'jeton'}, ${validation.scope === 'scoped' ? 'environnements choisis' : validation.scope === 'team' ? `équipe ${validation.teamName ?? ''}`.trim() : 'périmètre inconnu'})`,
    targetType: 'integration',
    targetId: 'coolify',
    actorUserId: options.actorUserId ?? null,
    metadata: { baseUrl, abilities: validation.abilities, scope: validation.scope, version: validation.version },
  });
  await applyHealthTransition({
    target: 'coolify',
    label: 'Coolify',
    previous: healthOfIntegrationStatus(previous),
    next: healthOfIntegrationStatus(status),
    expiresAt: declaredExpiresAt ? new Date(declaredExpiresAt) : null,
    impact: COOLIFY_IMPACT,
    href: '/integrations',
  });
  return { settings: await getCoolifySettings(), validation: publicValidation };
}

function expiryStatus(declaredExpiresAt: string | null, now: Date): DbStatus | null {
  if (!declaredExpiresAt) return null;
  const left = Date.parse(declaredExpiresAt) - now.getTime();
  if (!Number.isFinite(left)) return null;
  if (left <= 0) return 'expired';
  if (left < EXPIRING_THRESHOLD_MS) return 'expiring';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Periodic check: health → version → declared expiry
// ---------------------------------------------------------------------------------------------

const lastManual = globalThis as unknown as { __nueraCoolifyLastManualCheck?: number };

export async function checkCoolify(
  options: { trigger?: CheckTrigger; fetchImpl?: typeof fetch } = {},
): Promise<CoolifySettingsView> {
  const trigger = options.trigger ?? 'manual';
  if (trigger === 'manual') {
    if (Date.now() - (lastManual.__nueraCoolifyLastManualCheck ?? 0) < CHECK_MIN_INTERVAL_MS) return getCoolifySettings();
    lastManual.__nueraCoolifyLastManualCheck = Date.now();
  }
  const stored = await getStoredCoolify();
  if (!stored) return getCoolifySettings();
  const startedAt = new Date();
  const total = startTimer();
  const steps: CheckStep[] = [];
  const previous = stored.row.status as DbStatus;
  let next: DbStatus = 'connected';
  let transient = false;
  let reason: string | undefined;

  let token: string | null = null;
  try {
    token = readCoolifyToken(stored.row);
  } catch (error) {
    steps.push({ name: 'Déchiffrement du jeton', ok: false, ms: 0, providerMessage: error instanceof Error ? error.message : 'illisible' });
    next = 'error';
    reason = 'Jeton Coolify illisible : vérifiez APP_ENCRYPTION_KEY.';
  }
  if (token) {
    const client = createCoolifyClient({ baseUrl: stored.config.baseUrl, token, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    try {
      const health = await client.health();
      steps.push({ name: 'GET /api/health', ok: true, ms: health.ms, httpStatus: health.status });
      try {
        const version = await client.version();
        steps.push({ name: 'GET /api/v1/version', ok: true, ms: version.ms, httpStatus: version.status, providerMessage: version.data.slice(0, 40) });
      } catch (error) {
        steps.push(stepFromCoolifyError('GET /api/v1/version', error));
        if (error instanceof CoolifyError && (error.isCredentialError || error.kind === 'missing_ability')) {
          next = 'expired';
          reason = 'Coolify refuse le jeton.';
        } else {
          next = 'error';
          transient = error instanceof CoolifyError ? error.isTransient : true;
          reason = error instanceof CoolifyError ? error.message : 'Réponse inattendue de Coolify.';
        }
      }
    } catch (error) {
      steps.push(stepFromCoolifyError('GET /api/health', error));
      next = 'error';
      transient = true;
      reason = 'Coolify ne répond plus.';
    }
  }
  if (next === 'connected') {
    const declared = expiryStatus(stored.config.declaredExpiresAt, startedAt);
    if (declared === 'expired') {
      next = 'expired';
      reason = "Le jeton Coolify a dépassé sa date d'expiration.";
    } else if (declared === 'expiring') {
      next = 'expiring';
      reason = 'Le jeton Coolify expire bientôt.';
    }
  }
  const failed = next === 'expired' || next === 'error';
  const consecutiveFailures = failed ? stored.config.consecutiveFailures + 1 : 0;
  const status = applyHysteresis<DbStatus>({ previous, next, transient, consecutiveFailures });
  const failingSince = failed ? (stored.config.failingSince ?? startedAt.toISOString()) : null;
  const check: IntegrationCheck = {
    id: newCheckId(),
    target: 'coolify',
    trigger,
    startedAt: startedAt.toISOString(),
    durationMs: total(),
    steps,
    result: {
      status: next,
      ...(reason ? { reason } : {}),
      ...(next === 'expired' ? { action: { label: 'Reconnecter', kind: 'form' as const } } : {}),
    },
  };
  await updateCoolify(
    (config) => ({ ...config, consecutiveFailures, failingSince, lastCheck: check, history: pushHistory(config.history, check) }),
    {
      status,
      lastCheckedAt: startedAt,
      ...(next === 'connected' || next === 'expiring' ? { lastSuccessAt: startedAt } : {}),
      lastError: failed ? (reason ?? null) : null,
    },
  );
  await applyHealthTransition({
    target: 'coolify',
    label: 'Coolify',
    previous: healthOfIntegrationStatus(previous),
    next: healthOfIntegrationStatus(status),
    expiresAt: stored.config.declaredExpiresAt ? new Date(stored.config.declaredExpiresAt) : null,
    failingSince: failingSince ? new Date(failingSince) : null,
    impact: COOLIFY_IMPACT,
    reason: reason ?? null,
    href: '/integrations',
  });
  return getCoolifySettings();
}

export async function disconnectCoolify(options: { actorUserId?: string | null } = {}): Promise<boolean> {
  const stored = await getStoredCoolify();
  const deleted = await deleteCoolify();
  if (deleted) {
    await audit({
      action: 'integration.coolify.disconnected',
      summary: `Coolify déconnecté : ${tokenFingerprint(stored?.config.tokenIdPrefix ?? null) ?? 'jeton'} supprimé de Nuera Dev`,
      targetType: 'integration',
      targetId: 'coolify',
      actorUserId: options.actorUserId ?? null,
    });
    await applyHealthTransition({ target: 'coolify', label: 'Coolify', previous: 'error', next: 'inactive', impact: COOLIFY_IMPACT, href: '/integrations' });
  }
  return deleted;
}

// ---------------------------------------------------------------------------------------------
// Reads (applications, deployments) and project mapping
// ---------------------------------------------------------------------------------------------

async function client(options: { fetchImpl?: typeof fetch } = {}) {
  const credential = await getCoolifyCredential();
  if (!credential) throw new AppError('CONFLICT', "Coolify n'est pas connecté.");
  return createCoolifyClient({ ...credential, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
}

function toAppError(error: unknown, context: string): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof CoolifyError) {
    return new AppError(error.isCredentialError ? 'UPSTREAM' : error.isTransient ? 'UPSTREAM' : 'FORBIDDEN', `${error.message} (${context})`, {
      ...(error.providerMessage ? { raw: error.providerMessage } : {}),
    });
  }
  return new AppError('UPSTREAM', `Réponse inattendue de Coolify (${context}).`);
}

export async function listCoolifyApplications(options: { fetchImpl?: typeof fetch } = {}): Promise<CoolifyApplication[]> {
  try {
    return (await (await client(options)).applications()).data;
  } catch (error) {
    throw toAppError(error, 'applications');
  }
}

export async function getCoolifyApplication(uuid: string, options: { fetchImpl?: typeof fetch } = {}): Promise<CoolifyApplication> {
  try {
    return (await (await client(options)).application(uuid)).data;
  } catch (error) {
    throw toAppError(error, 'application');
  }
}

export async function listCoolifyDeployments(
  uuid: string,
  options: { take?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ count: number; deployments: CoolifyDeployment[] }> {
  try {
    return (await (await client(options)).deploymentsForApplication(uuid, { take: options.take ?? 5 })).data;
  } catch (error) {
    throw toAppError(error, 'déploiements');
  }
}

/** `owner/repo` from a Coolify `git_repository` (`owner/repo`, `https://github.com/owner/repo.git`, `git@github.com:owner/repo.git`). */
export function normalizeGitRepository(value: string | null | undefined): string | null {
  if (!value) return null;
  let repo = value.trim().toLowerCase();
  repo = repo.replace(/^git@github\.com:/, '').replace(/^(https?:\/\/)?(www\.)?github\.com\//, '');
  repo = repo.replace(/\.git$/, '').replace(/\/+$/, '');
  return /^[a-z0-9-]+\/[a-z0-9._-]+$/.test(repo) ? repo : null;
}

export interface ProjectLike {
  id: string;
  githubFullName: string;
  currentBranch?: string | null;
  defaultBranch?: string | null;
}

/** Applications of each project, the one deploying the project's branch first (research §3.7). */
export function mapApplicationsToProjects<P extends ProjectLike>(
  apps: CoolifyApplication[],
  list: P[],
): Map<string, CoolifyApplication[]> {
  const result = new Map<string, CoolifyApplication[]>();
  for (const project of list) {
    const fullName = project.githubFullName.toLowerCase();
    const branch = (project.currentBranch ?? project.defaultBranch ?? '').toLowerCase();
    const matches = apps
      .filter((app) => normalizeGitRepository(app.git_repository) === fullName)
      .sort((a, b) => {
        const aMatch = (a.git_branch ?? '').toLowerCase() === branch ? 0 : 1;
        const bMatch = (b.git_branch ?? '').toLowerCase() === branch ? 0 : 1;
        return aMatch - bMatch || (a.name ?? '').localeCompare(b.name ?? '');
      });
    if (matches.length) result.set(project.id, matches);
  }
  return result;
}

/** Fields of an application that may reach the browser (never passwords, webhook secrets, env values). */
export interface PublicCoolifyApplication {
  uuid: string;
  name: string | null;
  description: string | null;
  fqdn: string | null;
  gitRepository: string | null;
  gitBranch: string | null;
  gitCommitSha: string | null;
  status: string | null;
  buildPack: string | null;
  updatedAt: string | null;
}

export interface PublicCoolifyDeployment {
  uuid: string | null;
  status: string | null;
  commit: string | null;
  commitMessage: string | null;
  pullRequestId: number | null;
  deploymentUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export function toPublicApplication(app: CoolifyApplication): PublicCoolifyApplication {
  return {
    uuid: app.uuid,
    name: app.name ?? null,
    description: app.description ?? null,
    fqdn: app.fqdn ?? null,
    gitRepository: app.git_repository ?? null,
    gitBranch: app.git_branch ?? null,
    gitCommitSha: app.git_commit_sha ?? null,
    status: app.status ?? null,
    buildPack: app.build_pack ?? null,
    updatedAt: app.updated_at ?? null,
  };
}

export function toPublicDeployment(deployment: CoolifyDeployment): PublicCoolifyDeployment {
  return {
    uuid: deployment.deployment_uuid ?? null,
    status: deployment.status ?? null,
    commit: deployment.commit ?? null,
    commitMessage: deployment.commit_message ?? null,
    pullRequestId: deployment.pull_request_id ?? null,
    deploymentUrl: deployment.deployment_url ?? null,
    createdAt: deployment.created_at ?? null,
    updatedAt: deployment.updated_at ?? null,
  };
}

/** Coolify applications of one project with their latest deployments (browser-safe fields only). */
export async function getProjectCoolifyApplications(
  projectId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<Array<{ application: PublicCoolifyApplication; deployments: PublicCoolifyDeployment[] }>> {
  const [project] = await db
    .select({ id: projects.id, githubFullName: projects.githubFullName, currentBranch: projects.currentBranch, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new AppError('NOT_FOUND', 'Projet introuvable.');
  const apps = await listCoolifyApplications(options);
  const mapped = mapApplicationsToProjects(apps, [project]).get(project.id) ?? [];
  const out: Array<{ application: PublicCoolifyApplication; deployments: PublicCoolifyDeployment[] }> = [];
  for (const application of mapped.slice(0, 5)) {
    const deployments = await listCoolifyDeployments(application.uuid, { take: 5, ...options }).catch(() => ({
      count: 0,
      deployments: [] as CoolifyDeployment[],
    }));
    out.push({ application: toPublicApplication(application), deployments: deployments.deployments.map(toPublicDeployment) });
  }
  return out;
}

/** Number of non-archived projects mapped to at least one Coolify application. */
export async function countMappedProjects(options: { fetchImpl?: typeof fetch } = {}): Promise<number> {
  const list = await db
    .select({ id: projects.id, githubFullName: projects.githubFullName, currentBranch: projects.currentBranch, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(isNull(projects.archivedAt));
  const apps = await listCoolifyApplications(options);
  return mapApplicationsToProjects(apps, list).size;
}
