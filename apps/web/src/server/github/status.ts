import 'server-only';
import { AppError } from '@/server/errors';
import {
  applyHysteresis,
  newCheckId,
  pushHistory,
  startTimer,
  EXPIRING_THRESHOLD_MS,
  type CheckAction,
  type CheckHistoryEntry,
  type CheckStep,
  type CheckTrigger,
  type IntegrationCheck,
} from '@/server/integrations/model';
import { applyHealthTransition, healthOfIntegrationStatus } from '@/server/integrations/transitions';
import { audit } from '@/server/security/audit';
import { createOctokit, githubErrorHeaders, githubErrorMessage, githubErrorStatus, isTransientGithubError } from './client';
import { GITHUB_REQUIRED_PERMISSIONS, fallbackToken } from './config';
import { fetchInstallations, manageAccessUrl, partitionInstallations, toInstallationRecord } from './installations';
import { deleteGithubApp, getStoredGithubApp, readGithubRow, readGithubSecrets, updateGithubApp } from './store';
import { clearGithubTokenCache, createAppJwt, mintInstallationToken, type AppCredentials } from './tokens';
import type {
  GithubAccountStatus,
  GithubConfig,
  GithubInstallationRecord,
  GithubPermissionsSummary,
  GithubStatus,
} from './types';

type DbStatus = 'pending' | 'connected' | 'expiring' | 'expired' | 'error';

/** Copy shown in T7 « après » for GitHub. */
export const GITHUB_IMPACT = 'Synchronisation, push et pull requests suspendus. Le travail local continue.';
const INSTALL_ROUTE = '/api/integrations/github/install';
const CHECK_MIN_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------------------------
// Permissions summary (D07 « DROITS »)
// ---------------------------------------------------------------------------------------------

const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };
const PERMISSION_LABELS: Record<string, string> = {
  contents: 'contenu',
  pull_requests: 'pull requests',
  issues: 'issues',
  checks: 'checks',
  statuses: 'statuts',
};

function frenchList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} et ${items.at(-1)}`;
}

const capitalize = (value: string) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : value);

export function summarizePermissions(installations: Array<Pick<GithubInstallationRecord, 'permissions'>>): GithubPermissionsSummary {
  const granted: Record<string, string> = {};
  if (installations.length > 0) {
    const keys = new Set(installations.flatMap((item) => Object.keys(item.permissions)));
    for (const key of keys) {
      const levels = installations.map((item) => LEVEL[item.permissions[key] ?? ''] ?? 0);
      const lowest = Math.min(...levels);
      if (lowest > 0) granted[key] = Object.keys(LEVEL).find((name) => LEVEL[name] === lowest)!;
    }
  }
  const missing = Object.entries(GITHUB_REQUIRED_PERMISSIONS)
    .filter(([key, level]) => (LEVEL[granted[key] ?? ''] ?? 0) < LEVEL[level]!)
    .map(([key]) => key);
  const write = Object.keys(PERMISSION_LABELS).filter((key) => (LEVEL[granted[key] ?? ''] ?? 0) >= 2);
  const read = Object.keys(PERMISSION_LABELS).filter((key) => (LEVEL[granted[key] ?? ''] ?? 0) === 1);
  const writeLabels = write.map((key) => PERMISSION_LABELS[key]!);
  const readLabels = read.map((key) => PERMISSION_LABELS[key]!);
  const title = writeLabels.length
    ? writeLabels.map((label, index) => (index === 0 ? capitalize(label) : label)).join(' · ')
    : readLabels.length
      ? 'Lecture seule'
      : 'Aucun droit';
  const detailParts = [
    writeLabels.length ? 'lecture et écriture' : null,
    readLabels.length ? `${frenchList(readLabels)} en lecture` : null,
  ].filter(Boolean);
  return { granted, missing, title, detail: detailParts.join(' ; ') };
}

// ---------------------------------------------------------------------------------------------
// Status view (no network)
// ---------------------------------------------------------------------------------------------

interface FallbackState {
  status: DbStatus;
  login: string | null;
  expiresAt: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  failingSince: string | null;
  consecutiveFailures: number;
  reason: string | null;
  lastCheck: IntegrationCheck | null;
  history: CheckHistoryEntry[];
}

const globalForFallback = globalThis as unknown as { __nueraGithubFallback?: FallbackState };
const lastManualCheck = globalThis as unknown as { __nueraGithubLastManualCheck?: number };

function accountsOf(config: GithubConfig): GithubAccountStatus[] {
  return config.installations
    .filter((item) => config.allowedAccountIds.includes(item.accountId))
    .map((item) => ({
      login: item.accountLogin,
      type: item.accountType,
      installationId: item.id,
      repositorySelection: item.repositorySelection,
      repoCount: item.repoCount,
      suspended: Boolean(item.suspendedAt),
      suspendedBy: item.suspendedBy,
      manageUrl: item.htmlUrl,
    }));
}

const emptyPermissions: GithubPermissionsSummary = { granted: {}, missing: Object.keys(GITHUB_REQUIRED_PERMISSIONS), title: 'Aucun droit', detail: '' };

export async function getGithubStatus(): Promise<GithubStatus> {
  const stored = await getStoredGithubApp();
  if (stored) {
    const { row, config } = stored;
    const usable = config.installations.filter((item) => config.allowedAccountIds.includes(item.accountId) && !item.suspendedAt);
    const status = (['pending', 'connected', 'expiring', 'expired', 'error'] as const).includes(row.status as DbStatus)
      ? (row.status as DbStatus)
      : 'pending';
    return {
      mode: 'app',
      status,
      app: {
        id: config.appId,
        slug: config.slug,
        name: config.name,
        htmlUrl: config.htmlUrl,
        public: config.public,
        ownerLogin: config.owner?.login ?? null,
        createdAt: config.createdAt,
      },
      accounts: accountsOf(config),
      ignoredInstallations: config.ignoredInstallations,
      repoCount: config.repoCount,
      permissions: usable.length ? summarizePermissions(usable) : emptyPermissions,
      manageAccessUrl: manageAccessUrl(config.slug),
      installUrl: INSTALL_ROUTE,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      failingSince: config.failingSince,
      lastError: row.lastError,
      reason: config.lastCheck?.result.reason ?? (status === 'pending' ? 'Application non installée' : null),
      action: config.lastCheck?.result.action ?? (status === 'pending' ? { label: 'Installer sur GitHub', kind: 'external', url: INSTALL_ROUTE } : null),
      expiresAt: null,
      lastCheck: config.lastCheck,
      history: config.history,
    };
  }
  const unreadable = await readGithubRow();
  if (unreadable) {
    // A row exists but its configuration cannot be read (schema drift): say so, never pretend.
    return {
      mode: 'app',
      status: 'error',
      app: null,
      accounts: [],
      ignoredInstallations: 0,
      repoCount: null,
      permissions: emptyPermissions,
      manageAccessUrl: null,
      installUrl: null,
      lastCheckedAt: unreadable.lastCheckedAt?.toISOString() ?? null,
      lastSuccessAt: unreadable.lastSuccessAt?.toISOString() ?? null,
      failingSince: null,
      lastError: 'Enregistrement GitHub illisible.',
      reason: 'Enregistrement GitHub illisible : déconnectez GitHub puis reconnectez-le.',
      action: null,
      expiresAt: null,
      lastCheck: null,
      history: [],
    };
  }
  if (fallbackToken()) {
    const state = globalForFallback.__nueraGithubFallback;
    return {
      mode: 'fallback_token',
      status: state?.status ?? 'pending',
      app: null,
      accounts: state?.login
        ? [{ login: state.login, type: 'User', installationId: 0, repositorySelection: 'selected', repoCount: null, suspended: false, suspendedBy: null, manageUrl: null }]
        : [],
      ignoredInstallations: 0,
      repoCount: null,
      permissions: { granted: {}, missing: [], title: 'Jeton de secours', detail: 'droits définis à la création du jeton' },
      manageAccessUrl: null,
      installUrl: null,
      lastCheckedAt: state?.lastCheckedAt ?? null,
      lastSuccessAt: state?.lastSuccessAt ?? null,
      failingSince: state?.failingSince ?? null,
      lastError: state?.reason ?? null,
      reason: state?.reason ?? null,
      action: null,
      expiresAt: state?.expiresAt ?? null,
      lastCheck: state?.lastCheck ?? null,
      history: state?.history ?? [],
    };
  }
  return {
    mode: 'none',
    status: 'not_configured',
    app: null,
    accounts: [],
    ignoredInstallations: 0,
    repoCount: null,
    permissions: emptyPermissions,
    manageAccessUrl: null,
    installUrl: null,
    lastCheckedAt: null,
    lastSuccessAt: null,
    failingSince: null,
    lastError: null,
    reason: "GitHub n'est pas connecté.",
    action: { label: 'Connecter GitHub', kind: 'form', url: '/api/integrations/github/manifest' },
    expiresAt: null,
    lastCheck: null,
    history: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Checks (network, non-mutating: GETs + token minting)
// ---------------------------------------------------------------------------------------------

interface StepOutcome {
  status: DbStatus;
  transient: boolean;
  reason?: string;
  action?: CheckAction;
}

function stepFromError(name: string, ms: number, error: unknown): CheckStep {
  const status = githubErrorStatus(error);
  const message = githubErrorMessage(error);
  const headers = githubErrorHeaders(error);
  return {
    name,
    ok: false,
    ms,
    ...(status !== null && status !== 500 ? { httpStatus: status } : {}),
    ...(message ? { providerMessage: message } : {}),
    ...(headers['x-github-request-id'] ? { headers: { 'x-github-request-id': headers['x-github-request-id'] } } : {}),
  };
}

/**
 * Full diagnostic of the GitHub App (research §2.13): app JWT, installations, one token per
 * installation, permissions, repository counts, rate limit. Stores the result and notifies on
 * transitions (T7). Manual checks are limited to one every 10 s (the last result is returned).
 */
export async function checkGithub(options: { trigger?: CheckTrigger; actorUserId?: string | null } = {}): Promise<GithubStatus> {
  const trigger = options.trigger ?? 'manual';
  if (trigger === 'manual') {
    const last = lastManualCheck.__nueraGithubLastManualCheck ?? 0;
    if (Date.now() - last < CHECK_MIN_INTERVAL_MS) return getGithubStatus();
    lastManualCheck.__nueraGithubLastManualCheck = Date.now();
  }
  const stored = await getStoredGithubApp();
  if (!stored) {
    if (fallbackToken()) return checkFallbackToken(trigger);
    return getGithubStatus();
  }

  const startedAt = new Date();
  const total = startTimer();
  const steps: CheckStep[] = [];
  const previous = stored.row.status as DbStatus;
  let outcome: StepOutcome = { status: 'connected', transient: false };
  let installations = stored.config.installations;
  let ignored = stored.config.ignoredInstallations;
  let repoCount: number | null = stored.config.repoCount;

  let credentials: AppCredentials | null = null;
  try {
    credentials = { appId: stored.config.appId, privateKey: readGithubSecrets(stored.row).privateKeyPem };
  } catch (error) {
    steps.push({ name: 'Déchiffrement de la clé privée', ok: false, ms: 0, providerMessage: error instanceof Error ? error.message : 'illisible' });
    outcome = { status: 'error', transient: false, reason: "Identifiants de l'application illisibles : vérifiez APP_ENCRYPTION_KEY." };
  }

  // 1. JWT → GET /app
  if (credentials) {
    const timer = startTimer();
    try {
      const jwt = await createAppJwt(credentials);
      const { headers } = await createOctokit(jwt).request('GET /app');
      steps.push({ name: 'GET /app', ok: true, ms: timer(), httpStatus: 200, ...(headers['x-github-request-id'] ? { headers: { 'x-github-request-id': String(headers['x-github-request-id']) } } : {}) });
    } catch (error) {
      steps.push(stepFromError('GET /app', timer(), error));
      const status = githubErrorStatus(error);
      outcome =
        status === 401
          ? {
              status: 'expired',
              transient: false,
              reason: "La clé privée de l'application a été révoquée ou remplacée.",
              action: { label: "Ouvrir l'application sur GitHub", kind: 'external', url: stored.config.htmlUrl },
            }
          : error instanceof AppError
            ? { status: 'error', transient: false, reason: error.message }
            : { status: 'error', transient: isTransientGithubError(error), reason: 'GitHub ne répond pas.' };
      credentials = null;
    }
  }

  // 2. GET /app/installations
  if (credentials) {
    const timer = startTimer();
    try {
      const list = await fetchInstallations(credentials);
      steps.push({ name: 'GET /app/installations', ok: true, ms: timer(), httpStatus: 200 });
      const { kept, ignored: ignoredCount } = partitionInstallations(stored.config, list);
      ignored = ignoredCount;
      const previousRecords = new Map(installations.map((item) => [item.id, item]));
      installations = kept.map((item) => toInstallationRecord(item, previousRecords.get(item.id)));
      if (kept.length === 0) {
        outcome =
          previous === 'pending' || stored.config.installations.length === 0
            ? { status: 'pending', transient: false, reason: 'Application non installée', action: { label: 'Installer sur GitHub', kind: 'external', url: INSTALL_ROUTE } }
            : {
                status: 'expired',
                transient: false,
                reason: "L'application GitHub a été désinstallée.",
                action: { label: 'Réautoriser sur GitHub', kind: 'external', url: INSTALL_ROUTE },
              };
      }
    } catch (error) {
      steps.push(stepFromError('GET /app/installations', timer(), error));
      outcome = { status: 'error', transient: isTransientGithubError(error), reason: 'Liste des installations indisponible.' };
      credentials = null;
    }
  }

  // 3–5. One token per installation, permissions, repository count.
  if (credentials && installations.length > 0) {
    const problems: string[] = [];
    let action: CheckAction | undefined;
    let counted = 0;
    let anyCount = false;
    for (const installation of installations) {
      if (installation.suspendedAt) {
        problems.push(`Installation suspendue${installation.suspendedBy ? ` par ${installation.suspendedBy}` : ''} (${installation.accountLogin})`);
        action ??= { label: 'Réautoriser sur GitHub', kind: 'external', ...(installation.htmlUrl ? { url: installation.htmlUrl } : {}) };
        continue;
      }
      const missing = Object.entries(GITHUB_REQUIRED_PERMISSIONS).filter(
        ([key, level]) => (LEVEL[installation.permissions[key] ?? ''] ?? 0) < LEVEL[level]!,
      );
      if (missing.length) {
        problems.push(`Droits à accepter sur GitHub (${installation.accountLogin})`);
        action ??= { label: 'Accepter les droits sur GitHub', kind: 'external', ...(installation.htmlUrl ? { url: installation.htmlUrl } : {}) };
      }
      const timer = startTimer();
      try {
        const { token } = await mintInstallationToken({
          installationId: installation.id,
          permissions: { metadata: 'read' },
          credentials,
          refresh: true,
        });
        const { data, headers } = await createOctokit(token).request('GET /installation/repositories', { per_page: 1 });
        installation.repoCount = data.total_count;
        counted += data.total_count;
        anyCount = true;
        const limit = Number(headers['x-ratelimit-limit'] ?? 0);
        const remaining = Number(headers['x-ratelimit-remaining'] ?? 0);
        steps.push({
          name: `GET /installation/repositories · ${installation.accountLogin}`,
          ok: true,
          ms: timer(),
          httpStatus: 200,
          ...(limit
            ? { headers: { 'x-ratelimit-limit': String(limit), 'x-ratelimit-remaining': String(remaining) } }
            : {}),
          ...(limit && remaining < limit * 0.1 ? { providerMessage: 'Limite de requêtes GitHub presque atteinte.' } : {}),
        });
      } catch (error) {
        steps.push(stepFromError(`Jeton d'installation · ${installation.accountLogin}`, timer(), error));
        const status = error instanceof AppError ? (error.code === 'FORBIDDEN' ? 403 : null) : githubErrorStatus(error);
        if (status === 403 || status === 404 || status === 401) {
          problems.push(`Accès retiré pour ${installation.accountLogin}`);
          action ??= { label: 'Réautoriser sur GitHub', kind: 'external', url: INSTALL_ROUTE };
        } else {
          outcome = { status: 'error', transient: true, reason: 'GitHub ne répond pas.' };
        }
      }
    }
    if (anyCount) repoCount = counted;
    if (problems.length && outcome.status === 'connected') {
      outcome = { status: 'expired', transient: false, reason: problems.join(' ; '), ...(action ? { action } : {}) };
    }
  }

  const consecutiveFailures = outcome.status === 'connected' || outcome.status === 'pending' ? 0 : stored.config.consecutiveFailures + 1;
  const status = applyHysteresis<DbStatus>({ previous, next: outcome.status, transient: outcome.transient, consecutiveFailures });
  const failed = outcome.status !== 'connected' && outcome.status !== 'pending';
  const failingSince = failed ? (stored.config.failingSince ?? startedAt.toISOString()) : null;
  const check: IntegrationCheck = {
    id: newCheckId(),
    target: 'github',
    trigger,
    startedAt: startedAt.toISOString(),
    durationMs: total(),
    steps,
    result: {
      status: outcome.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.action ? { action: outcome.action } : {}),
    },
  };

  await updateGithubApp(
    (config) => ({
      ...config,
      installations,
      ignoredInstallations: ignored,
      repoCount,
      consecutiveFailures,
      failingSince,
      lastCheck: check,
      history: pushHistory(config.history, check),
    }),
    {
      status,
      lastCheckedAt: startedAt,
      ...(outcome.status === 'connected' ? { lastSuccessAt: startedAt } : {}),
      lastError: failed ? (outcome.reason ?? null) : null,
    },
  );
  await applyHealthTransition({
    target: 'github',
    label: 'GitHub',
    previous: healthOfIntegrationStatus(previous),
    next: healthOfIntegrationStatus(status),
    failingSince: failingSince ? new Date(failingSince) : null,
    impact: GITHUB_IMPACT,
    reason: outcome.reason ?? null,
    href: '/integrations',
  });
  if (trigger === 'manual' && options.actorUserId) {
    await audit({
      action: 'integration.github.checked',
      summary: `connexion GitHub vérifiée : ${status}`,
      targetType: 'integration',
      targetId: 'github',
      actorUserId: options.actorUserId,
    });
  }
  return getGithubStatus();
}

/** Parses `GitHub-Authentication-Token-Expiration` (« 2026-11-12 19:07:53 UTC »). */
export function parseTokenExpiration(value: string | undefined | null): Date | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim());
  if (!match) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  }
  const zone = !match[3] || match[3] === 'UTC' || match[3] === 'Z' ? 'Z' : match[3];
  const parsed = Date.parse(`${match[1]}T${match[2]}${zone}`);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

async function checkFallbackToken(trigger: CheckTrigger): Promise<GithubStatus> {
  const token = fallbackToken()!;
  const previousState = globalForFallback.__nueraGithubFallback;
  const previous: DbStatus = previousState?.status ?? 'pending';
  const startedAt = new Date();
  const timer = startTimer();
  const steps: CheckStep[] = [];
  let outcome: StepOutcome = { status: 'connected', transient: false };
  let login: string | null = previousState?.login ?? null;
  let expiresAt: Date | null = null;
  try {
    const { data, headers } = await createOctokit(token).request('GET /user');
    login = data.login;
    expiresAt = parseTokenExpiration(headers['github-authentication-token-expiration'] as string | undefined);
    steps.push({ name: 'GET /user', ok: true, ms: timer(), httpStatus: 200 });
    if (expiresAt) {
      const left = expiresAt.getTime() - Date.now();
      if (left <= 0) outcome = { status: 'expired', transient: false, reason: 'Le jeton de secours GitHub a expiré.' };
      else if (left < EXPIRING_THRESHOLD_MS) outcome = { status: 'expiring', transient: false, reason: 'Le jeton de secours GitHub expire bientôt.' };
    }
  } catch (error) {
    steps.push(stepFromError('GET /user', timer(), error));
    outcome =
      githubErrorStatus(error) === 401
        ? { status: 'expired', transient: false, reason: 'GitHub refuse le jeton de secours (GITHUB_FALLBACK_TOKEN).' }
        : { status: 'error', transient: isTransientGithubError(error), reason: 'GitHub ne répond pas.' };
  }
  const ok = outcome.status === 'connected' || outcome.status === 'expiring';
  const consecutiveFailures = ok ? 0 : (previousState?.consecutiveFailures ?? 0) + 1;
  const status = applyHysteresis<DbStatus>({ previous, next: outcome.status, transient: outcome.transient, consecutiveFailures });
  const failingSince = ok ? null : (previousState?.failingSince ?? startedAt.toISOString());
  const check: IntegrationCheck = {
    id: newCheckId(),
    target: 'github',
    trigger,
    startedAt: startedAt.toISOString(),
    durationMs: timer(),
    steps,
    result: { status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) },
  };
  globalForFallback.__nueraGithubFallback = {
    status,
    login,
    expiresAt: expiresAt?.toISOString() ?? null,
    lastCheckedAt: startedAt.toISOString(),
    lastSuccessAt: ok ? startedAt.toISOString() : (previousState?.lastSuccessAt ?? null),
    failingSince,
    consecutiveFailures,
    reason: outcome.reason ?? null,
    lastCheck: check,
    history: pushHistory(previousState?.history, check),
  };
  await applyHealthTransition({
    target: 'github',
    label: 'GitHub',
    previous: healthOfIntegrationStatus(previous),
    next: healthOfIntegrationStatus(status),
    expiresAt,
    failingSince: failingSince ? new Date(failingSince) : null,
    impact: GITHUB_IMPACT,
    reason: outcome.reason ?? null,
    href: '/integrations',
  });
  return getGithubStatus();
}

/**
 * « Déconnecter » : deletes the stored registration and its encrypted credentials. The app itself
 * stays on GitHub (deleting it is done there, by the owner).
 */
export async function disconnectGithub(options: { actorUserId?: string | null } = {}): Promise<{ deleted: boolean; appHtmlUrl: string | null }> {
  const stored = await getStoredGithubApp();
  const deleted = await deleteGithubApp();
  clearGithubTokenCache();
  if (deleted) {
    await audit({
      action: 'integration.github.disconnected',
      summary: `GitHub déconnecté : identifiants de l'application${stored ? ` « ${stored.config.name} »` : ''} supprimés de Nuera Dev`,
      targetType: 'integration',
      targetId: 'github',
      actorUserId: options.actorUserId ?? null,
    });
    await applyHealthTransition({
      target: 'github',
      label: 'GitHub',
      previous: 'error',
      next: 'inactive',
      impact: GITHUB_IMPACT,
      href: '/integrations',
    });
  }
  return { deleted, appHtmlUrl: stored?.config.htmlUrl ?? null };
}
