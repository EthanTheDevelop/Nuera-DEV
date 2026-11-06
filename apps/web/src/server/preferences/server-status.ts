import 'server-only';
import type { LiveSessionsView, MetricsView, RunnerHealthView, UptimeView, WebProcessView } from '@/features/settings/lib/types';
import { requireEnvironment, type RequestContext } from '@/server/tenancy/context';

/**
 * « Serveur VPS-3 »: only what the runner of the account's server and the web process really report
 * (health, live sessions, metrics, availability per day). Nothing about system packages or restart
 * policies is invented. Without a server: AppError CONFLICT reason NO_ENVIRONMENT, no runner call.
 */

const RUNNER_TIMEOUT_MS = 6_000;

type ServerContext = Pick<RequestContext, 'environment'>;

export async function getRunnerHealth(ctx: ServerContext): Promise<RunnerHealthView> {
  const { runner } = requireEnvironment(ctx);
  const health = await runner.health(undefined, { timeoutMs: RUNNER_TIMEOUT_MS });
  return {
    ok: health.ok,
    version: health.version,
    startedAt: health.startedAt,
    backend: health.backend,
    git: health.git,
    tmux: health.tmux,
    claude: health.claude,
    database: health.database,
    disk: health.disk,
    projectsRoot: health.projectsRoot,
  };
}

/** Live Claude processes of the server (the runner lists only its own sessions). */
export async function getLiveSessions(ctx: ServerContext): Promise<LiveSessionsView> {
  const { runner } = requireEnvironment(ctx);
  const result = await runner.listSessions(undefined, { timeoutMs: RUNNER_TIMEOUT_MS });
  const live = result.sessions.filter((session) => session.live);
  const names = [...new Set(live.map((session) => session.worktree?.name).filter((name): name is string => Boolean(name)))];
  return { count: live.length, names };
}

export async function getMetrics(ctx: ServerContext): Promise<MetricsView> {
  const { runner } = requireEnvironment(ctx);
  const m = await runner.systemMetrics(undefined, { timeoutMs: RUNNER_TIMEOUT_MS });
  return {
    sampledAt: m.sampledAt,
    cpuPercent: m.cpuPercent,
    cpuCount: m.cpuCount,
    memoryUsedBytes: m.memory.usedBytes,
    memoryTotalBytes: m.memory.totalBytes,
    diskUsedBytes: m.disk?.usedBytes ?? null,
    diskTotalBytes: m.disk?.totalBytes ?? null,
    sessionsLive: m.sessions.live,
    terminalsLive: m.terminals.live,
    runsLive: m.runs.live,
  };
}

/**
 * Availability per day of the server: its runner answers for its own uptime key (`uptimeServiceKey()`
 * — `runner` for the default server, `runner:<environmentId>` for the others).
 */
export async function getUptime(ctx: ServerContext, days = 30): Promise<UptimeView> {
  const { runner } = requireEnvironment(ctx);
  const report = await runner.systemUptime({ query: { days, service: 'runner' } }, { timeoutMs: RUNNER_TIMEOUT_MS });
  return {
    days: report.days.map((day) => ({ day: day.day, availability: day.availability, incidents: day.incidents })),
    availabilityPercent: report.availabilityPercent,
  };
}

/** Start of this web process (« Application Nuera Dev · en ligne · redémarrée il y a 18 j »). */
export function getWebProcess(now = Date.now()): WebProcessView {
  return { startedAt: new Date(now - process.uptime() * 1000).toISOString() };
}
