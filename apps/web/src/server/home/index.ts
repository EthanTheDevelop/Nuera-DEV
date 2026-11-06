import 'server-only';
import { uptimeDaily } from '@nuera/db/schema';
import type { ClaudeStatus, SystemMetrics } from '@nuera/shared/runner';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { SessionListItem } from '@/features/sessions/lib/contract';
import { pickQuickResume, sortActiveSessions } from '@/features/home/lib';
import type {
  ClaudeState,
  HomeActivity,
  HomeCapacity,
  HomeClaude,
  HomeData,
  HomeIntegrations,
  HomePartError,
  HomePendingPermission,
  HomeProjects,
  HomeServer,
  HomeSession,
  HomeSessions,
} from '@/features/home/types';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getIntegrationsOverview } from '@/server/integrations';
import { getRunnerForEnvironment } from '@/server/runner/client';
import { getCapacity, listSessions } from '@/server/sessions';
import { getSpaceSettings } from '@/server/settings';
import type { EnvironmentRef, RequestContext } from '@/server/tenancy/context';
import { loadActivity, runnerNotAnswering } from './activity';
import { buildIntegrations } from './integrations';
import { loadPendingPermissions, loadRecentProjects, type LogTarget } from './queries';

export type { HomeData } from '@/features/home/types';
export { buildIntegrations, integrationFooter } from './integrations';
export { mergeActivity, pullRequestMessage, repoWebUrl, runnerNotAnswering } from './activity';

/**
 * Accueil (D01 / M01) — everything the dashboard shows for the account of the request context,
 * read once per request: its space's projects, sessions, requests and history, its server (the
 * runner of the space), its integrations. Each part degrades on its own: a runner that does not
 * answer, an integration that cannot be read or a failing query only empties its own tile (with
 * the reason), never the page. Without a server assigned, the server-bound parts say so
 * (`no_environment`) and nothing is asked to any runner.
 *
 *   const data = await getHomeData(ctx);   // app/(shell)/page.tsx
 */

const RUNNER_TIMEOUT_MS = 4_000;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: HomePartError };

const NO_ENVIRONMENT: Outcome<never> = { ok: false, error: 'no_environment' };

function partError(error: unknown): HomePartError {
  if (runnerNotAnswering(error)) return 'runner_unavailable';
  if (error instanceof AppError && error.reason === 'NO_ENVIRONMENT') return 'no_environment';
  return 'failed';
}

async function attempt<T>(call: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    const reason = partError(error);
    if (reason === 'failed') console.error('[accueil]', error instanceof Error ? error.message : error);
    return { ok: false, error: reason };
  }
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function toHomeSession(item: SessionListItem, pending: ReadonlyMap<string, HomePendingPermission>): HomeSession {
  const request = pending.get(item.id) ?? null;
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    live: item.live,
    resumable: item.resumable,
    projectId: item.project.id,
    projectName: item.project.name,
    branch: item.branch,
    worktreeName: item.worktree && !item.worktree.isPrimary ? item.worktree.name : null,
    permissionMode: item.permissionMode,
    currentActivity: item.currentActivity,
    lastInstruction: item.lastInstruction,
    planDone: item.planDone,
    planTotal: item.planTotal,
    createdAt: item.createdAt,
    startedAt: item.startedAt,
    lastActivityAt: item.lastActivityAt,
    pendingPermission: request,
    limit: item.limit,
  };
}

/** Last heartbeat recorded for the server (« Dernier contact il y a 3 min ») when it does not answer. */
async function lastBeat(environment: EnvironmentRef): Promise<string | null> {
  try {
    const [row] = await db
      .select({ at: uptimeDaily.lastBeatAt })
      .from(uptimeDaily)
      .where(and(eq(uptimeDaily.service, environment.uptimeKey), isNotNull(uptimeDaily.lastBeatAt)))
      .orderBy(desc(uptimeDaily.lastBeatAt))
      .limit(1);
    return row?.at?.toISOString() ?? null;
  } catch {
    return null;
  }
}

async function toServer(environment: EnvironmentRef, metrics: Outcome<SystemMetrics>, claude: Outcome<ClaudeStatus>): Promise<HomeServer> {
  const m = metrics.ok ? metrics.value : null;
  const unavailable =
    (!metrics.ok && metrics.error === 'runner_unavailable') || (!claude.ok && claude.error === 'runner_unavailable');
  const availability: HomeServer['availability'] = metrics.ok || claude.ok ? 'available' : unavailable ? 'unavailable' : 'unknown';
  return {
    name: environment.name,
    location: environment.location,
    availability,
    metrics: m
      ? {
          cpuPercent: m.cpuPercent,
          memoryUsedBytes: m.memory.usedBytes,
          memoryTotalBytes: m.memory.totalBytes,
          diskUsedBytes: m.disk?.usedBytes ?? null,
          diskTotalBytes: m.disk?.totalBytes ?? null,
          sampledAt: m.sampledAt,
        }
      : null,
    uptimeSec: m ? m.uptimeSec : null,
    lastContactAt: m?.sampledAt ?? (availability === 'unavailable' ? await lastBeat(environment) : null),
  };
}

function toClaude(status: Outcome<ClaudeStatus>, defaultModel: string | null): HomeClaude {
  if (!status.ok) return { state: 'unknown', plan: null, defaultModel, checkedAt: null };
  const s = status.value;
  return {
    state: s.state as ClaudeState,
    // The plan only when the CLI states it, and only for a claude.ai sign-in.
    plan: s.state === 'connected' ? (s.auth?.subscriptionType ?? null) : null,
    defaultModel,
    checkedAt: s.checkedAt,
  };
}

/** GitHub statuses where a source of the space is connected and installed. */
const GITHUB_CONNECTED = new Set(['connected', 'expiring', 'expired', 'error']);

/**
 * « Connecter GitHub » of « Premiers pas »: true when a source (or the fallback token) is connected,
 * false when there is really nothing (or an application still to install), null when it cannot be
 * told yet (fallback token configured but not checked so far).
 */
function githubOnboarded(github: { status: string; mode?: string }): boolean | null {
  if (GITHUB_CONNECTED.has(github.status)) return true;
  if (github.mode === 'fallback_token' && github.status === 'pending') return null;
  return false;
}

export async function getHomeData(ctx: RequestContext): Promise<HomeData> {
  const environment = ctx.environment;
  const runner = environment ? getRunnerForEnvironment(environment.id) : null;
  const [settings, metrics, claudeStatus, pendingOutcome, projectsOutcome, integrationsOutcome] = await Promise.all([
    getSpaceSettings(ctx.space.id).catch(() => null),
    runner ? attempt(() => runner.systemMetrics(undefined, { timeoutMs: RUNNER_TIMEOUT_MS })) : Promise.resolve(NO_ENVIRONMENT),
    runner ? attempt(() => runner.claudeStatus({ query: { refresh: false, spaceId: ctx.space.id } }, { timeoutMs: RUNNER_TIMEOUT_MS })) : Promise.resolve(NO_ENVIRONMENT),
    attempt(() => loadPendingPermissions(ctx)),
    attempt(() => loadRecentProjects(ctx, 4)),
    attempt(() => getIntegrationsOverview(ctx)),
  ]);

  const pending = pendingOutcome.ok ? pendingOutcome.value : [];
  const pendingBySession = new Map<string, HomePendingPermission>();
  for (const request of pending) if (!pendingBySession.has(request.sessionId)) pendingBySession.set(request.sessionId, request);

  const recent = projectsOutcome.ok ? projectsOutcome.value : { items: [], total: 0, ever: 0, sessionsEver: false };
  const primaries: LogTarget[] = recent.items
    .filter((p) => p.status === 'ready')
    .map((p) => ({
      projectId: p.id,
      environmentId: p.environmentId,
      projectName: p.name,
      htmlUrl: p.htmlUrl,
      fullName: p.fullName,
      worktreeId: null,
      branch: p.branch,
    }));

  const [activeOutcome, capacityOutcome, activityOutcome] = await Promise.all([
    environment ? attempt(() => listSessions(ctx, { status: 'active' })) : Promise.resolve(NO_ENVIRONMENT),
    environment ? attempt(() => getCapacity(ctx)) : Promise.resolve(NO_ENVIRONMENT),
    recent.total > 0
      ? attempt(() => loadActivity(ctx, primaries))
      : Promise.resolve<Outcome<HomeActivity>>({ ok: true, value: { items: [], githubUrl: null, incomplete: false, error: null } }),
  ]);

  const items = activeOutcome.ok ? sortActiveSessions(activeOutcome.value.items.map((item) => toHomeSession(item, pendingBySession))) : [];
  const sessions: HomeSessions = {
    items,
    verified: activeOutcome.ok ? activeOutcome.value.verified : false,
    error: activeOutcome.ok ? null : activeOutcome.error,
  };

  let quickResume: HomeSession | null = pickQuickResume(items);
  if (!quickResume && recent.total > 0 && environment) {
    const history = await attempt(() => listSessions(ctx, { status: 'history', filter: 'reprise-possible', period: 'tout', limit: 1 }));
    const last = history.ok ? history.value.items[0] : undefined;
    if (last) quickResume = toHomeSession(last, pendingBySession);
  }

  const capacity: HomeCapacity = capacityOutcome.ok
    ? { active: capacityOutcome.value.active, max: capacityOutcome.value.max }
    : { active: items.filter((s) => s.live).length, max: environment?.maxConcurrentSessions ?? 0 };

  const projects: HomeProjects = {
    total: recent.total,
    items: recent.items.map(({ id, name, fullName, branch, sync, favorite, lastActivityAt }) => ({ id, name, fullName, branch, sync, favorite, lastActivityAt })),
  };

  let integrations: HomeIntegrations | null = null;
  let github: boolean | null = null;
  if (integrationsOutcome.ok) {
    try {
      integrations = buildIntegrations(integrationsOutcome.value);
      github = githubOnboarded(integrationsOutcome.value.github);
    } catch (error) {
      console.error('[accueil] intégrations', error instanceof Error ? error.message : error);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    firstName: firstName(ctx.user.name),
    server: environment ? await toServer(environment, metrics, claudeStatus) : null,
    claude: toClaude(claudeStatus, settings?.defaultModel ?? null),
    capacity,
    sessions,
    pending: pending.filter((p) => items.some((s) => s.id === p.sessionId) || !activeOutcome.ok),
    quickResume,
    projects,
    activity: activityOutcome.ok
      ? activityOutcome.value
      : { items: [], githubUrl: null, incomplete: true, error: activityOutcome.error },
    integrations,
    // Unreadable projects: the card is not offered on a guess (treated as set up).
    onboarding: { github, project: projectsOutcome.ok ? recent.ever > 0 : true, session: projectsOutcome.ok ? recent.sessionsEver : true },
  };
}
