import 'server-only';
import { cache } from 'react';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { sessions, uptimeDaily } from '@nuera/db/schema';
import type { CurrentUser } from '@/server/auth/session';
import { db } from '@/server/db';
import { listNotifications } from '@/server/notifications';
import { isRunnerUnavailable, runner } from '@/server/runner/client';
import { getAppSettings } from '@/server/settings';
import {
  ACTIVE_SESSION_STATUSES,
  type ClaudeState,
  type ShellClaude,
  type ShellData,
  type ShellMetrics,
  type ShellNotification,
  type ShellServer,
} from '@/components/shell/types';

/** The layout must not hang on a slow runner: the live stream completes the picture afterwards. */
const RUNNER_TIMEOUT_MS = 4_000;
const NOTIFICATION_LIMIT = 20;

/** Process-wide memory of the last successful runner answer (« Dernier contact il y a 3 min »). */
const memory = globalThis as unknown as { __nueraLastRunnerContact?: string };

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

async function lastRunnerBeat(): Promise<string | null> {
  try {
    const [row] = await db
      .select({ at: uptimeDaily.lastBeatAt })
      .from(uptimeDaily)
      .where(and(eq(uptimeDaily.service, 'runner'), isNotNull(uptimeDaily.lastBeatAt)))
      .orderBy(desc(uptimeDaily.lastBeatAt))
      .limit(1);
    return row?.at?.toISOString() ?? null;
  } catch {
    return null;
  }
}

async function loadActiveSessionIds(): Promise<string[]> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]), isNull(sessions.archivedAt)));
  return rows.map((r) => r.id);
}

async function loadNotifications(): Promise<ShellData['notifications']> {
  const { items, counts } = await listNotifications({ limit: NOTIFICATION_LIMIT });
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

/**
 * Everything the shell (sidebar, rail, tab bar, server card, global states T5/T6) needs, read once per
 * request (React cache: the layout and the page share it).
 *
 * - server label/location: app_settings (getAppSettings);
 * - live metrics + Claude CLI state: runner (`systemMetrics`, `claudeStatus`). RUNNER_UNAVAILABLE is not an
 *   exception here: it becomes `availability: 'unavailable'` and the shell renders T5;
 * - active sessions: sessions in new / running / waiting_permission / waiting_input;
 * - notifications for the bell.
 * Nothing is invented: a value the runner did not give stays null / 'unknown'.
 */
export const getShellData = cache(async (user: CurrentUser): Promise<ShellData> => {
  const [settings, metricsOutcome, claudeOutcome, activeIds, notifications] = await Promise.all([
    getAppSettings(),
    tryRunner(() => runner.systemMetrics(undefined, { timeoutMs: RUNNER_TIMEOUT_MS })),
    tryRunner(() => runner.claudeStatus({ query: { refresh: false } }, { timeoutMs: RUNNER_TIMEOUT_MS })),
    loadActiveSessionIds(),
    loadNotifications(),
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
    memory.__nueraLastRunnerContact = m.sampledAt;
  }

  const unavailable =
    (!metricsOutcome.ok && metricsOutcome.unavailable) || (!claudeOutcome.ok && claudeOutcome.unavailable);
  const availability: ShellServer['availability'] = metricsOutcome.ok || claudeOutcome.ok ? 'available' : unavailable ? 'unavailable' : 'unknown';

  let lastContactAt = metrics?.sampledAt ?? memory.__nueraLastRunnerContact ?? null;
  if (availability === 'unavailable' && !lastContactAt) lastContactAt = await lastRunnerBeat();

  let claude: ShellClaude = { state: 'unknown', version: null, checkedAt: null, error: null };
  if (claudeOutcome.ok) {
    const c = claudeOutcome.value;
    claude = { state: c.state as ClaudeState, version: c.version, checkedAt: c.checkedAt, error: c.error };
  }

  const statusUrl = process.env.NUERA_SERVER_STATUS_URL?.trim();

  return {
    user: { name: user.name, firstName: firstName(user.name), twoFactorEnabled: user.twoFactorEnabled },
    server: {
      name: settings.serverName,
      location: settings.serverLocation ?? null,
      statusUrl: statusUrl?.startsWith('https://') ? statusUrl : null,
      availability,
      metrics,
      lastContactAt,
    },
    claude,
    sessions: { activeIds, max: settings.maxConcurrentSessions },
    notifications,
    generatedAt: new Date().toISOString(),
  };
});
