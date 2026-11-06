import 'server-only';
import { cache } from 'react';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { projects, sessions, uptimeDaily } from '@nuera/db/schema';
import { db } from '@/server/db';
import { listNotifications } from '@/server/notifications';
import { getRunnerForEnvironment, isRunnerUnavailable } from '@/server/runner/client';
import { getEnvironmentSettings } from '@/server/settings';
import type { EnvironmentRef, RequestContext } from '@/server/tenancy/context';
import {
  ACTIVE_SESSION_STATUSES,
  type ClaudeState,
  type ShellClaude,
  type ShellData,
  type ShellEnvironment,
  type ShellMetrics,
  type ShellNotification,
  type ShellServer,
} from '@/components/shell/types';

/** The layout must not hang on a slow runner: the live stream completes the picture afterwards. */
const RUNNER_TIMEOUT_MS = 4_000;
const NOTIFICATION_LIMIT = 20;

/** Process-wide memory of the last successful answer of each server (« Dernier contact il y a 3 min »). */
const memory = globalThis as unknown as { __nueraLastRunnerContacts?: Map<string, string> };

function lastContacts(): Map<string, string> {
  memory.__nueraLastRunnerContacts ??= new Map();
  return memory.__nueraLastRunnerContacts;
}

type RunnerOutcome<T> = { ok: true; value: T } | { ok: false; unavailable: boolean };

async function tryRunner<T>(call: () => Promise<T>): Promise<RunnerOutcome<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, unavailable: isRunnerUnavailable(error) };
  }
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** Last heartbeat of this server's runner (`uptime_daily`, under the server's own uptime key). */
async function lastRunnerBeat(uptimeKey: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ at: uptimeDaily.lastBeatAt })
      .from(uptimeDaily)
      .where(and(eq(uptimeDaily.service, uptimeKey), isNotNull(uptimeDaily.lastBeatAt)))
      .orderBy(desc(uptimeDaily.lastBeatAt))
      .limit(1);
    return row?.at?.toISOString() ?? null;
  } catch {
    return null;
  }
}

/** Active sessions of the space (never another space's: Sessions bubble, tab-bar counter). */
async function loadActiveSessionIds(spaceId: string): Promise<string[]> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(projects, and(eq(projects.id, sessions.projectId), eq(projects.environmentId, sessions.environmentId)))
    .where(and(eq(projects.spaceId, spaceId), inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]), isNull(sessions.archivedAt)));
  return rows.map((r) => r.id);
}

/** The bell of the signed-in account only. */
async function loadNotifications(userId: string): Promise<ShellData['notifications']> {
  const { items, counts } = await listNotifications(userId, { limit: NOTIFICATION_LIMIT });
  const mapped: ShellNotification[] = items.map((n) => ({
    id: n.id,
    kind: n.kind,
    severity: n.severity,
    title: n.title,
    body: n.body,
    href: n.href,
    read: n.read,
    createdAt: n.createdAt,
  }));
  return { items: mapped, unread: counts.unread };
}

const NO_SERVER: ShellServer = { name: '', location: null, statusUrl: null, availability: 'unknown', metrics: null, lastContactAt: null };
const UNKNOWN_CLAUDE: ShellClaude = { state: 'unknown', version: null, checkedAt: null, error: null };

async function loadServer(environment: EnvironmentRef): Promise<{ server: ShellServer; claude: ShellClaude; environment: ShellEnvironment; max: number }> {
  const runner = getRunnerForEnvironment(environment.id);
  const [row, metricsOutcome, claudeOutcome] = await Promise.all([
    // Fresh row (a rename in Paramètres shows at once); the request context is cached 5 s.
    getEnvironmentSettings(environment.id).catch(() => null),
    tryRunner(() => runner.systemMetrics(undefined, { timeoutMs: RUNNER_TIMEOUT_MS })),
    tryRunner(() => runner.claudeStatus({ query: { refresh: false } }, { timeoutMs: RUNNER_TIMEOUT_MS })),
  ]);

  let metrics: ShellMetrics | null = null;
  if (metricsOutcome.ok) {
    const m = metricsOutcome.value;
    metrics = {
      cpuPercent: m.cpuPercent,
      memoryUsedBytes: m.memory.usedBytes,
      memoryTotalBytes: m.memory.totalBytes,
      diskUsedBytes: m.disk?.usedBytes ?? null,
      diskTotalBytes: m.disk?.totalBytes ?? null,
      sampledAt: m.sampledAt,
    };
    lastContacts().set(environment.id, m.sampledAt);
  }

  const unavailable = (!metricsOutcome.ok && metricsOutcome.unavailable) || (!claudeOutcome.ok && claudeOutcome.unavailable);
  const availability: ShellServer['availability'] = metricsOutcome.ok || claudeOutcome.ok ? 'available' : unavailable ? 'unavailable' : 'unknown';

  let lastContactAt = metrics?.sampledAt ?? lastContacts().get(environment.id) ?? null;
  if (availability === 'unavailable' && !lastContactAt) lastContactAt = await lastRunnerBeat(environment.uptimeKey);

  let claude = UNKNOWN_CLAUDE;
  if (claudeOutcome.ok) {
    const c = claudeOutcome.value;
    claude = { state: c.state as ClaudeState, version: c.version, checkedAt: c.checkedAt, error: c.error };
  }

  // The provider status page of NUERA_SERVER_STATUS_URL describes the default server only.
  const statusUrl = environment.isDefault ? process.env.NUERA_SERVER_STATUS_URL?.trim() : undefined;
  const name = row?.name ?? environment.name;
  const location = row ? row.location : environment.location;

  return {
    server: {
      name,
      location: location ?? null,
      statusUrl: statusUrl?.startsWith('https://') ? statusUrl : null,
      availability,
      metrics,
      lastContactAt,
    },
    claude,
    environment: { id: environment.id, name, location: location ?? null, status: row?.status ?? environment.status, isDefault: environment.isDefault },
    max: row?.maxConcurrentSessions ?? environment.maxConcurrentSessions,
  };
}

/**
 * Everything the shell (sidebar, rail, tab bar, server card, global states T5/T6) needs for the
 * request context, read once per request (React cache keyed by the cached context: the layout and
 * the page share it).
 *
 * - the account (id, role: identity guard, « INSTANCE » entries), its space and its server;
 * - live metrics + Claude CLI state from THAT server's runner (`systemMetrics`, `claudeStatus`).
 *   RUNNER_UNAVAILABLE is not an exception here: it becomes `availability: 'unavailable'` and the
 *   shell renders T5. Without a server: `environment: null`, no runner call, never T5;
 * - active sessions of the space; the account's own notifications for the bell.
 * Nothing is invented: a value the runner did not give stays null / 'unknown'.
 */
export const getShellData = cache(async (ctx: RequestContext): Promise<ShellData> => {
  const [serverPart, activeIds, notifications] = await Promise.all([
    ctx.environment ? loadServer(ctx.environment) : Promise.resolve(null),
    loadActiveSessionIds(ctx.space.id),
    loadNotifications(ctx.user.id),
  ]);

  return {
    user: {
      id: ctx.user.id,
      name: ctx.user.name,
      firstName: firstName(ctx.user.name),
      role: ctx.user.role,
      twoFactorEnabled: ctx.user.twoFactorEnabled,
    },
    space: { id: ctx.space.id, name: ctx.space.name },
    environment: serverPart?.environment ?? null,
    server: serverPart?.server ?? { ...NO_SERVER },
    claude: serverPart?.claude ?? UNKNOWN_CLAUDE,
    sessions: { activeIds, max: serverPart?.max ?? null },
    notifications,
    generatedAt: new Date().toISOString(),
  };
});
