import 'server-only';
import type { ClaudeStatus, SystemMetrics } from '@nuera/shared/runner';
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
import type { CurrentUser } from '@/server/auth/session';
import { getIntegrationsOverview } from '@/server/integrations';
import { isRunnerUnavailable, runner } from '@/server/runner/client';
import { getCapacity, listSessions } from '@/server/sessions';
import { getAppSettings } from '@/server/settings';
import { getShellData } from '@/server/shell/get-shell-data';
import { loadActivity } from './activity';
import { buildIntegrations } from './integrations';
import { loadPendingPermissions, loadRecentProjects, type LogTarget } from './queries';

export type { HomeData } from '@/features/home/types';
export { buildIntegrations, integrationFooter } from './integrations';
export { mergeActivity, pullRequestMessage, repoWebUrl } from './activity';

/**
 * Accueil (D01 / M01) — everything the dashboard shows, read once per request. Each part degrades
 * on its own: a runner that does not answer, an integration that cannot be read or a failing
 * query only empties its own tile (with the reason), never the page.
 *
 *   const data = await getHomeData(user);   // app/(shell)/page.tsx
 */

const RUNNER_TIMEOUT_MS = 4_000;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: HomePartError };

async function attempt<T>(call: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (!isRunnerUnavailable(error)) console.error('[accueil]', error instanceof Error ? error.message : error);
    return { ok: false, error: isRunnerUnavailable(error) ? 'runner_unavailable' : 'failed' };
  }
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
  };
}

function toServer(
  shell: Awaited<ReturnType<typeof getShellData>>,
  metrics: Outcome<SystemMetrics>,
): HomeServer {
  const m = metrics.ok ? metrics.value : null;
  return {
    name: shell.server.name,
    location: shell.server.location,
    availability: m ? 'available' : shell.server.availability,
    metrics: m
      ? {
          cpuPercent: m.cpuPercent,
          memoryUsedBytes: m.memory.usedBytes,
          memoryTotalBytes: m.memory.totalBytes,
          diskUsedBytes: m.disk?.usedBytes ?? null,
          diskTotalBytes: m.disk?.totalBytes ?? null,
          sampledAt: m.sampledAt,
        }
      : shell.server.metrics,
    uptimeSec: m ? m.uptimeSec : null,
    lastContactAt: m?.sampledAt ?? shell.server.lastContactAt,
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

export async function getHomeData(user: CurrentUser): Promise<HomeData> {
  const [shell, settings, metrics, claudeStatus, pendingOutcome, projectsOutcome] = await Promise.all([
    getShellData(user),
    getAppSettings(),
    attempt(() => runner.systemMetrics(undefined, { timeoutMs: RUNNER_TIMEOUT_MS })),
    attempt(() => runner.claudeStatus({ query: { refresh: false } }, { timeoutMs: RUNNER_TIMEOUT_MS })),
    attempt(() => loadPendingPermissions()),
    attempt(() => loadRecentProjects(4)),
  ]);

  const pending = pendingOutcome.ok ? pendingOutcome.value : [];
  const pendingBySession = new Map<string, HomePendingPermission>();
  for (const request of pending) if (!pendingBySession.has(request.sessionId)) pendingBySession.set(request.sessionId, request);

  const recent = projectsOutcome.ok ? projectsOutcome.value : { items: [], total: 0 };
  const primaries: LogTarget[] = recent.items
    .filter((p) => p.status === 'ready')
    .map((p) => ({ projectId: p.id, projectName: p.name, htmlUrl: p.htmlUrl, fullName: p.fullName, worktreeId: null, branch: p.branch }));

  const [activeOutcome, capacityOutcome, activityOutcome, integrationsOutcome] = await Promise.all([
    attempt(() => listSessions({ status: 'active' })),
    attempt(() => getCapacity()),
    recent.total > 0
      ? attempt(() => loadActivity(primaries))
      : Promise.resolve<Outcome<HomeActivity>>({ ok: true, value: { items: [], githubUrl: null, incomplete: false, error: null } }),
    attempt(async (): Promise<HomeIntegrations> => buildIntegrations(await getIntegrationsOverview())),
  ]);

  const items = activeOutcome.ok ? sortActiveSessions(activeOutcome.value.items.map((item) => toHomeSession(item, pendingBySession))) : [];
  const sessions: HomeSessions = {
    items,
    verified: activeOutcome.ok ? activeOutcome.value.verified : false,
    error: activeOutcome.ok ? null : activeOutcome.error,
  };

  let quickResume: HomeSession | null = pickQuickResume(items);
  if (!quickResume && recent.total > 0) {
    const history = await attempt(() => listSessions({ status: 'history', filter: 'reprise-possible', period: 'tout', limit: 1 }));
    const last = history.ok ? history.value.items[0] : undefined;
    if (last) quickResume = toHomeSession(last, pendingBySession);
  }

  const capacity: HomeCapacity = capacityOutcome.ok
    ? { active: capacityOutcome.value.active, max: capacityOutcome.value.max }
    : { active: items.filter((s) => s.live).length, max: settings.maxConcurrentSessions };

  const projects: HomeProjects = {
    total: recent.total,
    items: recent.items.map(({ id, name, fullName, branch, sync, favorite, lastActivityAt }) => ({ id, name, fullName, branch, sync, favorite, lastActivityAt })),
  };

  return {
    generatedAt: new Date().toISOString(),
    firstName: shell.user.firstName,
    server: toServer(shell, metrics),
    claude: toClaude(claudeStatus, settings.defaultModel ?? null),
    capacity,
    sessions,
    pending: pending.filter((p) => items.some((s) => s.id === p.sessionId) || !activeOutcome.ok),
    quickResume,
    projects,
    activity: activityOutcome.ok
      ? activityOutcome.value
      : { items: [], githubUrl: null, incomplete: true, error: activityOutcome.error },
    integrations: integrationsOutcome.ok ? integrationsOutcome.value : null,
  };
}
