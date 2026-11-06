import 'server-only';
import { githubSources, integrations as integrationsTable, mcpServers, spaces } from '@nuera/db/schema';
import { and, eq, isNull, max } from 'drizzle-orm';
import { db } from '@/server/db';
import { checkCoolify, getCoolifySettings, type CoolifySettingsView } from '@/server/coolify';
import { checkGithubSources, getGithubOverview, GITHUB_IMPACT, type GithubOverview } from '@/server/github';
import { checkActiveMcpServers, listMcpServers, type McpServerView } from '@/server/mcp';
import { COOLIFY_MUTATING_TOOLS, FIGMA_WRITE_TOOLS, type PresetServerContext } from '@/server/mcp/presets';
import { getPushStatus, type PushStatus } from '@/server/push';
import { CHECK_INTERVAL_MINUTES, STATUS_BADGES, type CheckTrigger } from './model';
import { formatClock, formatDayMonth, paragraph } from './transitions';

/**
 * Integration façade of a space: everything D07 (Intégrations), M07 and the D01 « Intégrations »
 * tile need, read from the database (no network call) and limited to that space (MULTICOMPTE §7).
 * Live checks: `runIntegrationChecks({ spaceId })` (web scheduler every 15 min, instrumentation.ts;
 * no runner triggers them) or the per-integration « Vérifier la connexion » / « Tester la
 * connexion » routes.
 */

/** What the overview needs to know about the request: the space and its server (copy of the presets). */
export interface IntegrationsScope {
  space: { id: string };
  environment?: { name: string; isDefault: boolean } | null;
}

/** Server of the request context as the preset copy needs it (« … sur VPS-3 », « chiffré par Nuera Dev »). */
export function presetServerOf(scope: Pick<IntegrationsScope, 'environment'>): PresetServerContext | null {
  return scope.environment ? { name: scope.environment.name, isDefault: scope.environment.isDefault } : null;
}

export interface DiagnosticBanner {
  /**
   * 'github' (the space's only GitHub source, or GITHUB_FALLBACK_TOKEN) | `github:<sourceId>` (one
   * source among several) | 'coolify' | `mcp:${name}`
   */
  target: string;
  /** Service behind the banner. */
  service: 'github' | 'coolify' | 'mcp';
  /** GitHub source concerned (null for the fallback token and the other services). */
  sourceId: string | null;
  /** `warn` = T7 « avant » (Alerte), `danger` = failing service (D07 diagnostic, T7 « après »). */
  tone: 'danger' | 'warn';
  /**
   * D07 `216:2247`: « Coolify ne répond plus depuis 09:12 » (unreachable, or Coolify token refused);
   * T7 `236:5401`: « L’accès GitHub a été retiré » (access withdrawn) /
   * « Autorisation Coolify bientôt expirée » (known expiry within 7 days).
   */
  title: string;
  /** What fails and what keeps working (« Le jeton du serveur MCP a expiré. Les sessions de … »). */
  body: string;
  since: string | null;
  /** Only actions with a destination: `journal` (« Voir le journal »), `reconnect` / `external`. */
  actions: Array<{ kind: 'journal' | 'reconnect' | 'external'; label: string; href?: string }>;
}

export interface IntegrationsOverview {
  github: GithubOverview;
  coolify: CoolifySettingsView;
  mcp: {
    servers: McpServerView[];
    total: number;
  };
  diagnostics: DiagnosticBanner[];
  guardrails: {
    /** « Production hors de portée »: tools refused to Claude + Coolify token scope. */
    productionOutOfReach: { deniedCoolifyTools: string[]; coolifyScope: CoolifySettingsView['scope']; productionVisible: boolean };
    /** « Un accès, un projet »: per-session --mcp-config --strict-mcp-config, claude.ai connectors off. */
    perProjectIsolation: { strictMcpConfig: true; claudeAiConnectorsDisabled: true };
    /** « Diagnostic automatique »: interval and last run. */
    autoCheck: { intervalMinutes: number; lastRunAt: string | null };
    deniedFigmaTools: string[];
  };
  push: PushStatus;
  /** D01 tile: integrations needing the owner (expired, unreachable, expiring). */
  attention: { count: number; items: Array<{ target: string; label: string; status: string; badge: string }> };
}

/** D07 « Diagnostic Coolify » body for a refused Coolify token (Figma copy). */
const COOLIFY_TOKEN_EXPIRED = 'Le jeton du serveur MCP a expiré.';

function bannerForService(input: {
  target: string;
  service: DiagnosticBanner['service'];
  sourceId?: string | null;
  label: string;
  status: string;
  since: string | null;
  expiresAt?: string | null;
  reason: string | null;
  impact: string;
  reconnect?: { kind: 'reconnect' | 'external'; label: string; href: string } | null;
  /** T7 « Renouveler » destination; no button when the credential is not renewable from Nuera Dev. */
  renewHref?: string | null;
  journalHref: string;
}): DiagnosticBanner | null {
  const since = input.since ? ` depuis ${formatClock(new Date(input.since))}` : '';
  const actions: DiagnosticBanner['actions'] = [
    { kind: 'journal', label: 'Voir le journal', href: input.journalHref },
    ...(input.reconnect ? [input.reconnect] : []),
  ];
  const coolify = input.target === 'coolify' || input.target === 'mcp:coolify';
  const identity = { target: input.target, service: input.service, sourceId: input.sourceId ?? null };
  if (input.status === 'expiring') {
    const when = input.expiresAt ? ` avant le ${formatDayMonth(new Date(input.expiresAt))}` : '';
    return {
      ...identity,
      tone: 'warn',
      title: `Autorisation ${input.label} bientôt expirée`,
      body: `Renouvelez l'accès${when}.`,
      since: null,
      actions: input.renewHref ? [{ kind: 'reconnect', label: 'Renouveler', href: input.renewHref }] : [],
    };
  }
  if (input.status === 'error' || input.status === 'expired') {
    return {
      ...identity,
      tone: 'danger',
      // Unreachable → « ne répond plus depuis » (D07). Refused credential → the D07 banner for
      // Coolify, T7 « après » for the other services.
      title:
        input.status === 'error' || coolify ? `${input.label} ne répond plus${since}` : `L'accès ${input.label} a été retiré`,
      body: paragraph(input.reason, input.impact),
      since: input.since,
      actions,
    };
  }
  // needs_auth (never authorised) is not a failure: the card shows « Connexion requise ».
  return null;
}

export async function getIntegrationsOverview(scope: IntegrationsScope): Promise<IntegrationsOverview> {
  const spaceId = scope.space.id;
  const presetServer = presetServerOf(scope);
  const [github, coolify] = await Promise.all([getGithubOverview(spaceId), getCoolifySettings(spaceId)]);
  const servers = await listMcpServers({ spaceId, coolifyBaseUrl: coolify.baseUrl, server: presetServer });

  const diagnostics: DiagnosticBanner[] = [];
  // One banner per failing GitHub source; a single source (or the fallback token) keeps the
  // historical target 'github' and label « GitHub ».
  const several = github.sources.length > 1;
  const githubTargets = github.sources.length
    ? github.sources.map((source) => ({ status: source, sourceId: source.id, target: several ? `github:${source.id}` : 'github', label: several ? `GitHub · ${source.label}` : 'GitHub' }))
    : [{ status: github, sourceId: null, target: 'github', label: 'GitHub' }];
  for (const item of githubTargets) {
    const banner = bannerForService({
      target: item.target,
      service: 'github',
      sourceId: item.sourceId,
      label: item.label,
      status: item.status.status,
      since: item.status.failingSince,
      // Only the env-only fallback PAT can expire: it is renewed outside Nuera Dev (no button).
      expiresAt: item.status.expiresAt,
      reason: item.status.reason,
      impact: GITHUB_IMPACT,
      reconnect: item.status.action?.url ? { kind: 'external', label: item.status.action.label, href: item.status.action.url } : null,
      journalHref: item.sourceId && several ? `/integrations?journal=github&source=${item.sourceId}` : '/integrations?journal=github',
    });
    if (banner) diagnostics.push(banner);
  }
  const projectsUsing = (preset: string) => {
    const names = servers.find((server) => server.preset === preset)?.projects.filter((item) => item.enabled).map((item) => item.name) ?? [];
    if (names.length === 0) return 'Les sessions';
    return `Les sessions de ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} et ${names.at(-1)}`}`;
  };
  const coolifyImpact = `${projectsUsing('coolify')} continuent, sans accès aux environnements de développement.`;
  if (coolify.configured) {
    const banner = bannerForService({
      target: 'coolify',
      service: 'coolify',
      label: 'Coolify',
      status: coolify.status,
      since: coolify.failingSince,
      expiresAt: coolify.declaredExpiresAt,
      reason: coolify.status === 'expired' ? COOLIFY_TOKEN_EXPIRED : coolify.reason,
      impact: coolifyImpact,
      reconnect: { kind: 'reconnect', label: 'Reconnecter', href: '/integrations/mcp/coolify' },
      renewHref: '/integrations/mcp/coolify',
      journalHref: '/integrations?journal=coolify',
    });
    if (banner) diagnostics.push(banner);
  }
  // One banner per failing service: a failing Coolify banner already covers its MCP server.
  const coolifyFailing = diagnostics.some((banner) => banner.target === 'coolify' && banner.tone === 'danger');
  for (const server of servers) {
    if (server.displayStatus === 'disabled') continue;
    if (server.preset === 'coolify' && coolifyFailing) continue;
    const banner = bannerForService({
      target: `mcp:${server.name}`,
      service: 'mcp',
      label: server.label,
      status: server.displayStatus,
      since: server.failingSince,
      reason: server.preset === 'coolify' && server.displayStatus === 'expired' ? COOLIFY_TOKEN_EXPIRED : server.lastError,
      impact:
        server.preset === 'coolify'
          ? coolifyImpact
          : `${server.preset ? projectsUsing(server.preset) : 'Les sessions'} continuent, sans accès au serveur MCP ${server.label}.`,
      reconnect: { kind: 'reconnect', label: 'Reconnecter', href: `/integrations/mcp/${server.name}` },
      journalHref: `/integrations/mcp/${server.name}?journal=1`,
    });
    if (banner) diagnostics.push(banner);
  }

  const attentionItems: IntegrationsOverview['attention']['items'] = [];
  for (const item of githubTargets) {
    if (['expired', 'error', 'expiring'].includes(item.status.status)) {
      attentionItems.push({ target: item.target, label: item.label, status: item.status.status, badge: STATUS_BADGES[item.status.status as 'expired'].label });
    }
  }
  if (coolify.configured && ['expired', 'error', 'expiring'].includes(coolify.status)) {
    attentionItems.push({ target: 'coolify', label: 'Coolify', status: coolify.status, badge: STATUS_BADGES[coolify.status as 'expired'].label });
  }
  const coolifyAttention = coolify.configured && ['expired', 'error'].includes(coolify.status);
  for (const server of servers) {
    if (['expired', 'needs_auth', 'error'].includes(server.displayStatus) && !(server.preset === 'coolify' && coolifyAttention)) {
      attentionItems.push({ target: `mcp:${server.name}`, label: server.label, status: server.displayStatus, badge: server.badge.label });
    }
  }

  // « Diagnostic automatique » of THIS space only.
  const [[lastIntegrationRun], [lastSourceRun], [lastMcpRun]] = await Promise.all([
    db.select({ at: max(integrationsTable.lastCheckedAt) }).from(integrationsTable).where(eq(integrationsTable.spaceId, spaceId)),
    db.select({ at: max(githubSources.lastCheckedAt) }).from(githubSources).where(eq(githubSources.spaceId, spaceId)),
    db.select({ at: max(mcpServers.lastCheckedAt) }).from(mcpServers).where(eq(mcpServers.spaceId, spaceId)),
  ]);
  const lastRunTimes = [lastIntegrationRun?.at, lastSourceRun?.at, lastMcpRun?.at, github.lastCheckedAt ? new Date(github.lastCheckedAt) : null].filter(
    (value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()),
  );
  const lastRunAt = lastRunTimes.length ? new Date(Math.max(...lastRunTimes.map((value) => value.getTime()))).toISOString() : null;

  return {
    github,
    coolify,
    mcp: { servers, total: servers.length },
    diagnostics,
    guardrails: {
      productionOutOfReach: {
        deniedCoolifyTools: COOLIFY_MUTATING_TOOLS.map((tool) => `mcp__coolify__${tool}`),
        coolifyScope: coolify.scope,
        productionVisible: coolify.productionVisible,
      },
      perProjectIsolation: { strictMcpConfig: true, claudeAiConnectorsDisabled: true },
      autoCheck: { intervalMinutes: CHECK_INTERVAL_MINUTES, lastRunAt },
      deniedFigmaTools: FIGMA_WRITE_TOOLS.map((tool) => `mcp__figma__${tool}`),
    },
    push: getPushStatus(),
    attention: { count: attentionItems.length, items: attentionItems },
  };
}

export interface IntegrationChecksSummary {
  spaceId: string;
  startedAt: string;
  durationMs: number;
  /** Aggregate GitHub status of the space (null: nothing to check). */
  github: { status: string } | { error: string } | null;
  /** One entry per GitHub source checked. */
  githubSources: Array<{ sourceId: string; status: string } | { sourceId: string; error: string }>;
  coolify: { status: string } | { error: string } | null;
  mcp: Array<{ name: string; status: string; error?: string }>;
}

export interface RunIntegrationChecksOptions {
  spaceId: string;
  trigger?: CheckTrigger;
  /** Scheduled run: skip the targets checked less than this long ago (10 min for the web scheduler). */
  skipCheckedWithinMs?: number;
}

const inflight = globalThis as unknown as { __nueraIntegrationChecks?: Map<string, Promise<IntegrationChecksSummary>> };
const running = (inflight.__nueraIntegrationChecks ??= new Map());

/**
 * Runs the checks of ONE space (its GitHub sources or the fallback token of the default server's
 * space, its Coolify, its MCP servers used by a project) in parallel. Concurrent calls for the same
 * space share the same run. Transitions notify the members of that space (T7).
 */
export function runIntegrationChecks(options: RunIntegrationChecksOptions): Promise<IntegrationChecksSummary> {
  const { spaceId } = options;
  const current = running.get(spaceId);
  if (current) return current;
  const trigger = options.trigger ?? 'schedule';
  const skip = options.skipCheckedWithinMs ? { skipCheckedWithinMs: options.skipCheckedWithinMs } : {};
  const run = (async (): Promise<IntegrationChecksSummary> => {
    const started = Date.now();
    const settle = async <T>(task: () => Promise<T>, pick: (value: T) => string) => {
      try {
        return { status: pick(await task()) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'erreur' };
      }
    };
    const [github, coolify, mcp] = await Promise.all([
      (async () => {
        const overview = await getGithubOverview(spaceId);
        if (overview.mode === 'none') return { aggregate: null, sources: [] };
        try {
          const result = await checkGithubSources({ spaceId, trigger, ...skip });
          return { aggregate: { status: result.overview.status }, sources: result.sources };
        } catch (error) {
          return { aggregate: { error: error instanceof Error ? error.message : 'erreur' }, sources: [] };
        }
      })(),
      (async () => {
        const settings = await getCoolifySettings(spaceId);
        return settings.configured ? settle(() => checkCoolify({ spaceId, trigger, ...skip }), (value) => value.status) : null;
      })(),
      checkActiveMcpServers({ spaceId, trigger, ...skip }).catch((error: unknown) => [
        { name: '*', status: 'failed', error: error instanceof Error ? error.message : 'erreur' },
      ]),
    ]);
    return {
      spaceId,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      github: github.aggregate,
      githubSources: github.sources,
      coolify,
      mcp,
    };
  })();
  running.set(spaceId, run);
  return run.finally(() => {
    if (running.get(spaceId) === run) running.delete(spaceId);
  });
}

/** @deprecated name of {@link runIntegrationChecks} (a space is now required). */
export const runAllIntegrationChecks = runIntegrationChecks;

/** Spaces that have something to check: a GitHub source, a Coolify token or an MCP server in use (non-archived spaces). */
export async function listSpacesToCheck(): Promise<string[]> {
  const ids = new Set<string>();
  const active = isNull(spaces.archivedAt);
  const [sources, tokens, registries] = await Promise.all([
    db.selectDistinct({ id: githubSources.spaceId }).from(githubSources).innerJoin(spaces, and(eq(spaces.id, githubSources.spaceId), active)),
    db.selectDistinct({ id: integrationsTable.spaceId }).from(integrationsTable).innerJoin(spaces, and(eq(spaces.id, integrationsTable.spaceId), active)),
    db.selectDistinct({ id: mcpServers.spaceId }).from(mcpServers).innerJoin(spaces, and(eq(spaces.id, mcpServers.spaceId), active)),
  ]);
  for (const row of [...sources, ...tokens, ...registries]) ids.add(row.id);
  // The space of the default server may check GITHUB_FALLBACK_TOKEN without any row.
  if (process.env.GITHUB_FALLBACK_TOKEN?.trim()) {
    const { defaultServerSpaceId } = await import('@/server/github/config');
    const fallback = await defaultServerSpaceId();
    if (fallback) ids.add(fallback);
  }
  return [...ids].sort();
}

export type { CheckTrigger } from './model';
