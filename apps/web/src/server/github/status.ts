import 'server-only';
import { githubSources, projects } from '@nuera/db/schema';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '@/server/db';
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
import { GITHUB_REQUIRED_PERMISSIONS, MAX_GITHUB_SOURCES_PER_SPACE, fallbackTokenFor } from './config';
import { fetchInstallations, manageAccessUrl, partitionInstallations, toInstallationRecord } from './installations';
import {
  GITHUB_SOURCE_NOT_FOUND,
  getGithubSource,
  getGithubSourceRow,
  labelOf,
  labelTaken,
  listGithubSources,
  parseGithubConfig,
  readGithubSecrets,
  updateGithubSource,
  type GithubSourceRow,
  type GithubSourceScope,
  type StoredGithubSource,
} from './store';
import { clearGithubTokenCache, createAppJwt, mintInstallationToken, type AppCredentials } from './tokens';
import type {
  GithubAccountStatus,
  GithubConfig,
  GithubInstallationRecord,
  GithubOverview,
  GithubPermissionsSummary,
  GithubSourceStatus,
  GithubStatus,
} from './types';

type DbStatus = 'pending' | 'connected' | 'expiring' | 'expired' | 'error';

/** Copy shown in T7 « après » for GitHub. */
export const GITHUB_IMPACT = 'Synchronisation, push et pull requests suspendus. Le travail local continue.';
export const INSTALL_ROUTE = '/api/integrations/github/install';
const CHECK_MIN_INTERVAL_MS = 10_000;
/** Concurrent source checks of one space. */
const CHECK_CONCURRENCY = 3;

/** « Installer sur GitHub » / « Réautoriser sur GitHub » of one source. */
export function installRouteOf(sourceId: string): string {
  return `${INSTALL_ROUTE}?source=${encodeURIComponent(sourceId)}`;
}

/** Notification / check target of a source (`integration:github:<sourceId>:<état>`, MULTICOMPTE §14.1). */
export function githubTarget(sourceId: string | 'fallback'): string {
  return `github:${sourceId}`;
}

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
// Status views (no network)
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

/** State of the GITHUB_FALLBACK_TOKEN checks, per space (in memory: the token lives in the environment). */
const globalForFallback = globalThis as unknown as { __nueraGithubFallback?: Map<string, FallbackState> };
const fallbackStates = (globalForFallback.__nueraGithubFallback ??= new Map());
/** Last manual check per source id (or `space:<id>` for « every source »). */
const globalForManual = globalThis as unknown as { __nueraGithubManualChecks?: Map<string, number> };
const manualChecks = (globalForManual.__nueraGithubManualChecks ??= new Map());

/** Forgets the manual-check throttles and the fallback states (tests). */
export function resetGithubCheckState(): void {
  manualChecks.clear();
  fallbackStates.clear();
}

function accountsOf(sourceId: string, config: GithubConfig): GithubAccountStatus[] {
  return config.installations
    .filter((item) => config.allowedAccountIds.includes(item.accountId))
    .map((item) => ({
      sourceId,
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

const emptyPermissions = (): GithubPermissionsSummary => ({ granted: {}, missing: Object.keys(GITHUB_REQUIRED_PERMISSIONS), title: 'Aucun droit', detail: '' });

const DB_STATUSES = ['pending', 'connected', 'expiring', 'expired', 'error'] as const;
const dbStatusOf = (value: string): DbStatus => ((DB_STATUSES as readonly string[]).includes(value) ? (value as DbStatus) : 'pending');

/** Action URLs of a source: the historical install route (persisted in old checks) gets `?source=`. */
function withSourceAction(action: CheckAction | null | undefined, sourceId: string): CheckAction | null {
  if (!action) return null;
  return action.url === INSTALL_ROUTE ? { ...action, url: installRouteOf(sourceId) } : action;
}

function withSourceCheck(check: IntegrationCheck | null, sourceId: string): IntegrationCheck | null {
  if (!check?.result.action) return check;
  const action = withSourceAction(check.result.action, sourceId);
  return { ...check, result: { ...check.result, ...(action ? { action } : {}) } };
}

type SourceProjects = Map<string, Array<{ id: string; name: string }>>;

/** Non-archived projects of the space bound to each source. */
async function projectsBySource(spaceId: string): Promise<SourceProjects> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, sourceId: projects.githubSourceId })
    .from(projects)
    .where(and(eq(projects.spaceId, spaceId), isNull(projects.archivedAt), isNotNull(projects.githubSourceId)));
  const map: SourceProjects = new Map();
  for (const row of rows) {
    if (!row.sourceId) continue;
    map.set(row.sourceId, [...(map.get(row.sourceId) ?? []), { id: row.id, name: row.name }]);
  }
  return map;
}

/** D07 tile of one source (no network). */
export function getGithubSourceStatus(source: StoredGithubSource, bound: Array<{ id: string; name: string }> = []): GithubSourceStatus {
  const { row, config, id } = source;
  const usable = config.installations.filter((item) => config.allowedAccountIds.includes(item.accountId) && !item.suspendedAt);
  const status = dbStatusOf(row.status);
  const install = installRouteOf(id);
  return {
    id,
    sourceId: id,
    label: source.label,
    createdAt: row.createdAt.toISOString(),
    projects: bound,
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
    accounts: accountsOf(id, config),
    ignoredInstallations: config.ignoredInstallations,
    repoCount: config.repoCount,
    permissions: usable.length ? summarizePermissions(usable) : emptyPermissions(),
    manageAccessUrl: manageAccessUrl(config.slug),
    installUrl: install,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    failingSince: config.failingSince,
    lastError: row.lastError,
    reason: config.lastCheck?.result.reason ?? (status === 'pending' ? 'Application non installée' : null),
    action:
      withSourceAction(config.lastCheck?.result.action, id) ??
      (status === 'pending' ? { label: 'Installer sur GitHub', kind: 'external', url: install } : null),
    expiresAt: null,
    lastCheck: withSourceCheck(config.lastCheck, id),
    history: config.history,
  };
}

/** A row whose configuration cannot be read (schema drift): said so, never pretended. */
function unreadableStatus(row: GithubSourceRow, bound: Array<{ id: string; name: string }>): GithubSourceStatus {
  return {
    id: row.id,
    sourceId: row.id,
    label: labelOf(row, null),
    createdAt: row.createdAt.toISOString(),
    projects: bound,
    mode: 'app',
    status: 'error',
    app: null,
    accounts: [],
    ignoredInstallations: 0,
    repoCount: null,
    permissions: emptyPermissions(),
    manageAccessUrl: null,
    installUrl: null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    failingSince: null,
    lastError: 'Enregistrement GitHub illisible.',
    reason: 'Enregistrement GitHub illisible : déconnectez GitHub puis reconnectez-le.',
    action: null,
    expiresAt: null,
    lastCheck: null,
    history: [],
  };
}

function fallbackStatus(state: FallbackState | undefined): GithubStatus {
  return {
    mode: 'fallback_token',
    sourceId: null,
    label: null,
    status: state?.status ?? 'pending',
    app: null,
    accounts: state?.login
      ? [{ sourceId: null, login: state.login, type: 'User', installationId: 0, repositorySelection: 'selected', repoCount: null, suspended: false, suspendedBy: null, manageUrl: null }]
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

function notConfiguredStatus(): GithubStatus {
  return {
    mode: 'none',
    sourceId: null,
    label: null,
    status: 'not_configured',
    app: null,
    accounts: [],
    ignoredInstallations: 0,
    repoCount: null,
    permissions: emptyPermissions(),
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

/** error > expired > expiring > pending > connected. */
const SEVERITY: Record<GithubStatus['status'], number> = { error: 5, expired: 4, expiring: 3, pending: 2, connected: 1, not_configured: 0 };
const FAILING = new Set<GithubStatus['status']>(['error', 'expired', 'pending']);

const AGGREGATE_REASON: Partial<Record<GithubStatus['status'], [string, string]>> = {
  error: ['en erreur', 'en erreur'],
  expired: ['à réautoriser', 'à réautoriser'],
  pending: ['à installer', 'à installer'],
  expiring: ['bientôt expirée', 'bientôt expirées'],
};

/** « 1 source sur 3 à réautoriser » */
export function aggregateReason(worst: GithubStatus['status'], count: number, total: number): string | null {
  const words = AGGREGATE_REASON[worst];
  if (!words || count === 0) return null;
  return `${count} ${count > 1 ? 'sources' : 'source'} sur ${total} ${count > 1 ? words[1] : words[0]}`;
}

function latest(values: Array<string | null>): string | null {
  const times = values.filter((value): value is string => Boolean(value)).sort();
  return times.at(-1) ?? null;
}

function earliest(values: Array<string | null>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort()[0] ?? null;
}

function aggregate(sources: GithubSourceStatus[], usable: GithubInstallationRecord[]): GithubStatus {
  if (sources.length === 1) {
    const { id: _id, createdAt: _createdAt, projects: _projects, ...single } = sources[0]!;
    return single;
  }
  const worst = sources.reduce<GithubStatus['status']>((current, item) => (SEVERITY[item.status] > SEVERITY[current] ? item.status : current), 'connected');
  const worstCount = sources.filter((item) => item.status === worst).length;
  const counts = sources.map((item) => item.repoCount).filter((value): value is number => typeof value === 'number');
  const reason = worst === 'connected' ? null : aggregateReason(worst, worstCount, sources.length);
  return {
    mode: 'app',
    sourceId: null,
    label: null,
    status: worst,
    app: null,
    accounts: sources.flatMap((item) => item.accounts),
    ignoredInstallations: sources.reduce((sum, item) => sum + item.ignoredInstallations, 0),
    repoCount: counts.length ? counts.reduce((sum, value) => sum + value, 0) : null,
    permissions: usable.length ? summarizePermissions(usable) : emptyPermissions(),
    manageAccessUrl: null,
    installUrl: null,
    lastCheckedAt: latest(sources.map((item) => item.lastCheckedAt)),
    lastSuccessAt: latest(sources.map((item) => item.lastSuccessAt)),
    failingSince: earliest(sources.filter((item) => FAILING.has(item.status)).map((item) => item.failingSince)),
    lastError: reason,
    reason,
    action: null,
    expiresAt: null,
    lastCheck: null,
    history: [],
  };
}

/**
 * GitHub of a space (D07): aggregate + every source. Without source: GITHUB_FALLBACK_TOKEN for the
 * space of the default server, otherwise « non connecté ».
 */
export async function getGithubOverview(spaceId: string): Promise<GithubOverview> {
  const [{ sources, unreadable }, bound] = await Promise.all([listGithubSources(spaceId), projectsBySource(spaceId)]);
  const views: GithubSourceStatus[] = [
    ...sources.map((source) => getGithubSourceStatus(source, bound.get(source.id) ?? [])),
    ...unreadable.map((row) => unreadableStatus(row, bound.get(row.id) ?? [])),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const extra = {
    sources: views,
    sourceCount: views.length,
    failingSourceCount: views.filter((item) => FAILING.has(item.status)).length,
    maxSources: MAX_GITHUB_SOURCES_PER_SPACE,
    canAddSource: views.length < MAX_GITHUB_SOURCES_PER_SPACE,
  };
  if (views.length > 0) {
    const usable = sources.flatMap((source) =>
      source.config.installations.filter((item) => source.config.allowedAccountIds.includes(item.accountId) && !item.suspendedAt),
    );
    return { ...aggregate(views, usable), ...extra };
  }
  if (await fallbackTokenFor(spaceId)) return { ...fallbackStatus(fallbackStates.get(spaceId)), ...extra };
  return { ...notConfiguredStatus(), ...extra };
}

/** @deprecated use {@link getGithubOverview} (same shape, plus the sources). */
export const getGithubStatus = getGithubOverview;

/** One source of the space (NOT_FOUND « Source GitHub introuvable. » for another space's id). */
export async function getGithubSourceView(scope: GithubSourceScope): Promise<GithubSourceStatus> {
  const row = await getGithubSourceRow(scope);
  const bound = (await projectsBySource(scope.spaceId)).get(row.id) ?? [];
  const config = parseGithubConfig(row);
  return config ? getGithubSourceStatus({ id: row.id, spaceId: row.spaceId, label: labelOf(row, config), row, config }, bound) : unreadableStatus(row, bound);
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

/** Label and destination of the notifications of a source: « GitHub » alone, « GitHub · <libellé> » among several. */
async function transitionTarget(spaceId: string, source: { id: string; label: string }): Promise<{ label: string; href: string }> {
  const { sources, unreadable } = await listGithubSources(spaceId);
  const several = sources.length + unreadable.length > 1;
  return several ? { label: `GitHub · ${source.label}`, href: `/integrations?source=${source.id}` } : { label: 'GitHub', href: '/integrations' };
}

export interface CheckGithubOptions {
  trigger?: CheckTrigger;
  actorUserId?: string | null;
  /** Scheduled run: skip what was checked less than this long ago. */
  skipCheckedWithinMs?: number;
}

/**
 * Full diagnostic of one source (research §2.13): app JWT, installations, one token per
 * installation, permissions, repository counts, rate limit. Stores the result and notifies the
 * members of the space on transitions (T7). Manual checks of a source are limited to one every 10 s
 * (the last result is returned).
 */
export async function checkGithubSource(input: GithubSourceScope & CheckGithubOptions): Promise<GithubSourceStatus> {
  const trigger = input.trigger ?? 'manual';
  const stored = await getGithubSource(input);
  if (trigger === 'manual') {
    if (Date.now() - (manualChecks.get(stored.id) ?? 0) < CHECK_MIN_INTERVAL_MS) return getGithubSourceView(input);
    manualChecks.set(stored.id, Date.now());
  }
  if (input.skipCheckedWithinMs && stored.row.lastCheckedAt && Date.now() - stored.row.lastCheckedAt.getTime() < input.skipCheckedWithinMs) {
    return getGithubSourceView(input);
  }
  const scope = { spaceId: stored.spaceId, sourceId: stored.id };
  const install = installRouteOf(stored.id);

  const startedAt = new Date();
  const total = startTimer();
  const steps: CheckStep[] = [];
  const previous = dbStatusOf(stored.row.status);
  let outcome: StepOutcome = { status: 'connected', transient: false };
  let installations = stored.config.installations;
  let ignored = stored.config.ignoredInstallations;
  let repoCount: number | null = stored.config.repoCount;

  let credentials: AppCredentials | null = null;
  try {
    credentials = { sourceId: stored.id, appId: stored.config.appId, privateKey: readGithubSecrets(stored.row).privateKeyPem };
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
            ? { status: 'pending', transient: false, reason: 'Application non installée', action: { label: 'Installer sur GitHub', kind: 'external', url: install } }
            : {
                status: 'expired',
                transient: false,
                reason: "L'application GitHub a été désinstallée.",
                action: { label: 'Réautoriser sur GitHub', kind: 'external', url: install },
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
          action ??= { label: 'Réautoriser sur GitHub', kind: 'external', url: install };
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
    target: githubTarget(stored.id),
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

  await updateGithubSource(
    scope,
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
  const target = await transitionTarget(stored.spaceId, stored);
  await applyHealthTransition({
    spaceId: stored.spaceId,
    target: githubTarget(stored.id),
    label: target.label,
    previous: healthOfIntegrationStatus(previous),
    next: healthOfIntegrationStatus(status),
    failingSince: failingSince ? new Date(failingSince) : null,
    impact: GITHUB_IMPACT,
    reason: outcome.reason ?? null,
    href: target.href,
  });
  if (trigger === 'manual' && input.actorUserId) {
    await audit({
      action: 'integration.github.checked',
      summary: `connexion GitHub vérifiée (${stored.label}) : ${status}`,
      targetType: 'integration',
      targetId: stored.id,
      actorUserId: input.actorUserId,
      spaceId: stored.spaceId,
    });
  }
  return getGithubSourceView(scope);
}

async function inBatches<T, R>(items: T[], size: number, task: (item: T) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = [];
  for (let index = 0; index < items.length; index += size) {
    results.push(...(await Promise.allSettled(items.slice(index, index + size).map(task))));
  }
  return results;
}

export interface GithubChecksResult {
  overview: GithubOverview;
  /** One entry per source checked (scheduler summary). */
  sources: Array<{ sourceId: string; status: string } | { sourceId: string; error: string }>;
}

/** Every source of the space (scheduler / « Vérifier la connexion » of the aggregate). */
export async function checkGithubSources(input: { spaceId: string } & CheckGithubOptions): Promise<GithubChecksResult> {
  const trigger = input.trigger ?? 'manual';
  const { sources } = await listGithubSources(input.spaceId);
  if (sources.length === 0) {
    if (await fallbackTokenFor(input.spaceId)) {
      const state = fallbackStates.get(input.spaceId);
      const recent = input.skipCheckedWithinMs && state?.lastCheckedAt && Date.now() - Date.parse(state.lastCheckedAt) < input.skipCheckedWithinMs;
      if (!recent) await checkFallbackToken(input.spaceId, trigger);
    }
    return { overview: await getGithubOverview(input.spaceId), sources: [] };
  }
  const results = await inBatches(sources, CHECK_CONCURRENCY, (source) =>
    checkGithubSource({
      spaceId: input.spaceId,
      sourceId: source.id,
      // The space-wide throttle of a manual run is applied by the caller.
      trigger: trigger === 'manual' ? 'setup' : trigger,
      actorUserId: null,
      ...(input.skipCheckedWithinMs ? { skipCheckedWithinMs: input.skipCheckedWithinMs } : {}),
    }),
  );
  return {
    overview: await getGithubOverview(input.spaceId),
    sources: results.map((result, index) =>
      result.status === 'fulfilled'
        ? { sourceId: sources[index]!.id, status: result.value.status }
        : { sourceId: sources[index]!.id, error: result.reason instanceof Error ? result.reason.message : 'erreur' },
    ),
  };
}

/**
 * « Vérifier la connexion » of every source of the space (or of GITHUB_FALLBACK_TOKEN for the space
 * of the default server without source). Manual: once every 10 s per space.
 */
export async function checkGithub(input: { spaceId: string } & CheckGithubOptions): Promise<GithubOverview> {
  const trigger = input.trigger ?? 'manual';
  if (trigger === 'manual') {
    const key = `space:${input.spaceId}`;
    if (Date.now() - (manualChecks.get(key) ?? 0) < CHECK_MIN_INTERVAL_MS) return getGithubOverview(input.spaceId);
    manualChecks.set(key, Date.now());
  }
  const { overview } = await checkGithubSources(input);
  if (trigger === 'manual' && input.actorUserId) {
    await audit({
      action: 'integration.github.checked',
      summary: `connexion GitHub vérifiée : ${overview.status}`,
      targetType: 'integration',
      targetId: 'github',
      actorUserId: input.actorUserId,
      spaceId: input.spaceId,
    });
  }
  return overview;
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

async function checkFallbackToken(spaceId: string, trigger: CheckTrigger): Promise<void> {
  const token = await fallbackTokenFor(spaceId);
  if (!token) return;
  const previousState = fallbackStates.get(spaceId);
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
    target: githubTarget('fallback'),
    trigger,
    startedAt: startedAt.toISOString(),
    durationMs: timer(),
    steps,
    result: { status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) },
  };
  fallbackStates.set(spaceId, {
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
  });
  await applyHealthTransition({
    spaceId,
    target: githubTarget('fallback'),
    label: 'GitHub',
    previous: healthOfIntegrationStatus(previous),
    next: healthOfIntegrationStatus(status),
    expiresAt,
    failingSince: failingSince ? new Date(failingSince) : null,
    impact: GITHUB_IMPACT,
    reason: outcome.reason ?? null,
    href: '/integrations',
  });
}

// ---------------------------------------------------------------------------------------------
// Label, disconnection
// ---------------------------------------------------------------------------------------------

/** Renames a source (« nuera-studio » → « Studio »), audited. */
export async function renameGithubSource(input: GithubSourceScope & { label: string; actorUserId: string | null }): Promise<GithubSourceStatus> {
  const label = input.label.trim();
  if (!label || label.length > 40) throw new AppError('VALIDATION', 'Nom de la source : 1 à 40 caractères.');
  const before = await getGithubSource(input);
  const { sources, unreadable } = await listGithubSources(input.spaceId);
  const others = [
    ...sources.filter((item) => item.id !== before.id).map((item) => item.label),
    ...unreadable.filter((row) => row.id !== before.id).map((row) => labelOf(row, null)),
  ];
  if (labelTaken(label, others)) {
    throw new AppError('CONFLICT', 'Une autre source GitHub de votre espace porte déjà ce nom.', {
      untouched: "La source GitHub n'a pas été renommée.",
    });
  }
  await updateGithubSource(input, (config) => config, { label });
  await audit({
    action: 'integration.github.source_updated',
    summary: `source GitHub « ${before.label} » renommée « ${label} »`,
    targetType: 'integration',
    targetId: before.id,
    actorUserId: input.actorUserId,
    spaceId: input.spaceId,
  });
  return getGithubSourceView(input);
}

/** « 2 projets actifs : Nuera OS et Roux Conseil » */
function projectList(names: string[]): string {
  const list = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} et ${names.at(-1)}`;
  return `${names.length} ${names.length > 1 ? 'projets actifs' : 'projet actif'} : ${list}`;
}

/**
 * « Déconnecter » a source: deletes its registration and encrypted credentials (the app itself
 * stays on GitHub: the owner deletes it there). Refused while a non-archived project of the space
 * uses the source; archived projects lose their binding. Only that app's cached tokens are dropped.
 */
export async function disconnectGithubSource(input: GithubSourceScope & { actorUserId: string | null }): Promise<{ deleted: boolean; appHtmlUrl: string | null }> {
  const row = await getGithubSourceRow(input);
  const config = parseGithubConfig(row);
  const label = labelOf(row, config);
  const deleted = await db.transaction(async (tx) => {
    // The source row is locked first: a project binding it at the same time (creation, lazy
    // binding) waits on its foreign key, so the check below cannot miss it.
    const [locked] = await tx
      .select({ id: githubSources.id })
      .from(githubSources)
      .where(and(eq(githubSources.id, row.id), eq(githubSources.spaceId, input.spaceId)))
      .for('update')
      .limit(1);
    if (!locked) return false;
    const active = await tx
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.spaceId, input.spaceId), eq(projects.githubSourceId, row.id), isNull(projects.archivedAt)));
    if (active.length > 0) {
      throw new AppError('CONFLICT', `Cette source GitHub est utilisée par ${projectList(active.map((item) => item.name))}.`, {
        detail: 'Archivez ces projets avant de déconnecter la source.',
        untouched: "La source GitHub n'a pas été modifiée.",
        data: { projects: active },
      });
    }
    await tx
      .update(projects)
      .set({ githubSourceId: null, githubInstallationId: null })
      .where(and(eq(projects.spaceId, input.spaceId), eq(projects.githubSourceId, row.id)));
    const rows = await tx
      .delete(githubSources)
      .where(and(eq(githubSources.id, row.id), eq(githubSources.spaceId, input.spaceId)))
      .returning({ id: githubSources.id });
    return rows.length > 0;
  });
  if (!deleted) throw new AppError('NOT_FOUND', GITHUB_SOURCE_NOT_FOUND);
  if (row.appId !== null) clearGithubTokenCache({ appId: row.appId });
  manualChecks.delete(row.id);
  await audit({
    action: 'integration.github.disconnected',
    summary: `GitHub déconnecté : identifiants de l'application « ${config?.name ?? label} » supprimés de Nuera Dev`,
    targetType: 'integration',
    targetId: row.id,
    actorUserId: input.actorUserId,
    spaceId: input.spaceId,
    metadata: { appId: row.appId, label },
  });
  await applyHealthTransition({
    spaceId: input.spaceId,
    target: githubTarget(row.id),
    label: 'GitHub',
    previous: 'error',
    next: 'inactive',
    impact: GITHUB_IMPACT,
    href: '/integrations',
  });
  return { deleted: true, appHtmlUrl: config?.htmlUrl ?? null };
}

/**
 * Historical DELETE /api/integrations/github: the space's only source. Several sources → CONFLICT
 * (the per-source route says which one); none → `{ deleted: false }`.
 */
export async function disconnectGithub(input: { spaceId: string; actorUserId: string | null }): Promise<{ deleted: boolean; appHtmlUrl: string | null }> {
  const { sources, unreadable } = await listGithubSources(input.spaceId);
  const ids = [...sources.map((item) => item.id), ...unreadable.map((item) => item.id)];
  if (ids.length === 0) return { deleted: false, appHtmlUrl: null };
  if (ids.length > 1) {
    throw new AppError('CONFLICT', 'Plusieurs sources GitHub sont connectées : précisez celle à déconnecter.');
  }
  return disconnectGithubSource({ spaceId: input.spaceId, sourceId: ids[0]!, actorUserId: input.actorUserId });
}
