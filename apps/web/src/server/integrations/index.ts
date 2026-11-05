import 'server-only';
import { integrations as integrationsTable, mcpServers } from '@nuera/db/schema';
import { max } from 'drizzle-orm';
import { db } from '@/server/db';
import { checkCoolify, getCoolifySettings, type CoolifySettingsView } from '@/server/coolify';
import { checkGithub, getGithubStatus, GITHUB_IMPACT, type GithubStatus } from '@/server/github';
import { checkActiveMcpServers, listMcpServers, type McpServerView } from '@/server/mcp';
import { COOLIFY_MUTATING_TOOLS, FIGMA_WRITE_TOOLS } from '@/server/mcp/presets';
import { getPushStatus, type PushStatus } from '@/server/push';
import { CHECK_INTERVAL_MINUTES, STATUS_BADGES, type CheckTrigger } from './model';
import { formatClock, formatDayMonth, paragraph } from './transitions';

/**
 * Integration façade: everything D07 (Intégrations), M07 and the D01 « Intégrations » tile need,
 * read from the database (no network call). Live checks: `runAllIntegrationChecks()` (runner
 * scheduler every 15 min through POST /api/internal/integrations/check) or the per-integration
 * « Vérifier la connexion » / « Tester la connexion » routes.
 */

export interface DiagnosticBanner {
  /** 'github' | 'coolify' | `mcp:${name}` */
  target: string;
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
  github: GithubStatus;
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
  if (input.status === 'expiring') {
    const when = input.expiresAt ? ` avant le ${formatDayMonth(new Date(input.expiresAt))}` : '';
    return {
      target: input.target,
      tone: 'warn',
      title: `Autorisation ${input.label} bientôt expirée`,
      body: `Renouvelez l'accès${when}.`,
      since: null,
      actions: input.renewHref ? [{ kind: 'reconnect', label: 'Renouveler', href: input.renewHref }] : [],
    };
  }
  if (input.status === 'error' || input.status === 'expired') {
    return {
      target: input.target,
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

export async function getIntegrationsOverview(): Promise<IntegrationsOverview> {
  const [github, coolify] = await Promise.all([getGithubStatus(), getCoolifySettings()]);
  const servers = await listMcpServers({ coolifyBaseUrl: coolify.baseUrl });

  const diagnostics: DiagnosticBanner[] = [];
  const githubBanner = bannerForService({
    target: 'github',
    label: 'GitHub',
    status: github.status,
    since: github.failingSince,
    // Only the env-only fallback PAT can expire: it is renewed outside Nuera Dev (no button).
    expiresAt: github.expiresAt,
    reason: github.reason,
    impact: GITHUB_IMPACT,
    reconnect: github.action?.url ? { kind: 'external', label: github.action.label, href: github.action.url } : null,
    journalHref: '/integrations?journal=github',
  });
  if (githubBanner) diagnostics.push(githubBanner);
  const projectsUsing = (preset: string) => {
    const names = servers.find((server) => server.preset === preset)?.projects.filter((item) => item.enabled).map((item) => item.name) ?? [];
    if (names.length === 0) return 'Les sessions';
    return `Les sessions de ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} et ${names.at(-1)}`}`;
  };
  const coolifyImpact = `${projectsUsing('coolify')} continuent, sans accès aux environnements de développement.`;
  if (coolify.configured) {
    const banner = bannerForService({
      target: 'coolify',
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
  if (['expired', 'error', 'expiring'].includes(github.status)) {
    attentionItems.push({ target: 'github', label: 'GitHub', status: github.status, badge: STATUS_BADGES[github.status as 'expired'].label });
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

  const [lastIntegrationRun] = await db.select({ at: max(integrationsTable.lastCheckedAt) }).from(integrationsTable);
  const [lastMcpRun] = await db.select({ at: max(mcpServers.lastCheckedAt) }).from(mcpServers);
  const lastRunTimes = [lastIntegrationRun?.at, lastMcpRun?.at].filter((value): value is Date => value instanceof Date);
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
  startedAt: string;
  durationMs: number;
  github: { status: string } | { error: string } | null;
  coolify: { status: string } | { error: string } | null;
  mcp: Array<{ name: string; status: string; error?: string }>;
}

const inflight = globalThis as unknown as { __nueraIntegrationChecks?: Promise<IntegrationChecksSummary> };

/**
 * Runs every check (GitHub, Coolify, MCP servers used by a project) in parallel. Concurrent calls
 * share the same run. Transitions create the T7 notifications.
 */
export function runAllIntegrationChecks(options: { trigger?: CheckTrigger } = {}): Promise<IntegrationChecksSummary> {
  if (inflight.__nueraIntegrationChecks) return inflight.__nueraIntegrationChecks;
  const trigger = options.trigger ?? 'schedule';
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
        const status = await getGithubStatus();
        return status.mode === 'none' ? null : settle(() => checkGithub({ trigger }), (value) => value.status);
      })(),
      (async () => {
        const settings = await getCoolifySettings();
        return settings.configured ? settle(() => checkCoolify({ trigger }), (value) => value.status) : null;
      })(),
      checkActiveMcpServers({ trigger }).catch((error: unknown) => [
        { name: '*', status: 'failed', error: error instanceof Error ? error.message : 'erreur' },
      ]),
    ]);
    return { startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, github, coolify, mcp };
  })();
  inflight.__nueraIntegrationChecks = run;
  return run.finally(() => {
    inflight.__nueraIntegrationChecks = undefined;
  });
}

export type { CheckTrigger } from './model';
