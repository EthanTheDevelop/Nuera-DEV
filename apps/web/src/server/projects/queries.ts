import 'server-only';
import { commandRuns, operations, permissionRequests, sessions, worktrees } from '@nuera/db/schema';
import { DEFAULT_DEV_SERVER_NAME } from '@nuera/shared/runner';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '@/server/db';
import type { ProjectRow } from './access';
import type { CommandKind, ProjectListItem, ProjectOperationView, ProjectSessionCounts, ProjectSessionView, RunView } from './types';

/*
 * Read helpers of the Projets domain. They take project ids that ALREADY come out of a query
 * scoped to the space of the request (`requireProject`, `ofSpace` lists): never call them with an
 * id read from a request. Nothing here is exported by the module's public surface.
 */

export type { ProjectRow };

export const LIVE_STATUSES = ['running', 'waiting_permission', 'waiting_input'] as const;
const SYNC_OPERATION_KINDS = ['fetch', 'pull'] as const;

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

export async function primaryWorktreeId(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: worktrees.id })
    .from(worktrees)
    .where(and(eq(worktrees.projectId, projectId), eq(worktrees.isPrimary, true), isNull(worktrees.removedAt)))
    .limit(1);
  return row?.id ?? null;
}

const emptyCounts = (): ProjectSessionCounts => ({ active: 0, interrupted: 0, finished: 0, total: 0 });

/** Session counters per project (archived sessions excluded). */
export async function sessionCountsByProject(projectIds: string[]): Promise<Map<string, ProjectSessionCounts & { lastActivityAt: Date | null }>> {
  const out = new Map<string, ProjectSessionCounts & { lastActivityAt: Date | null }>();
  if (projectIds.length === 0) return out;
  const rows = await db
    .select({
      projectId: sessions.projectId,
      active: sql<number>`count(*) filter (where ${sessions.status} in ('running','waiting_permission','waiting_input'))::int`,
      interrupted: sql<number>`count(*) filter (where ${sessions.status} = 'interrupted')::int`,
      finished: sql<number>`count(*) filter (where ${sessions.status} = 'finished')::int`,
      total: sql<number>`count(*)::int`,
      lastActivityAt: sql<Date | null>`max(coalesce(${sessions.lastActivityAt}, ${sessions.endedAt}, ${sessions.startedAt}, ${sessions.createdAt}))`,
    })
    .from(sessions)
    .where(and(inArray(sessions.projectId, projectIds), ne(sessions.status, 'archived'), isNull(sessions.archivedAt)))
    .groupBy(sessions.projectId);
  for (const row of rows) {
    const last = row.lastActivityAt ? new Date(row.lastActivityAt) : null;
    out.set(row.projectId, {
      active: Number(row.active),
      interrupted: Number(row.interrupted),
      finished: Number(row.finished),
      total: Number(row.total),
      lastActivityAt: last && !Number.isNaN(last.getTime()) ? last : null,
    });
  }
  return out;
}

/** Latest running clone/fetch/pull per project, and whether the last pull ended on a conflict. */
export async function operationStateByProject(
  projectIds: string[],
): Promise<Map<string, { running: ProjectOperationView | null; conflict: boolean }>> {
  const out = new Map<string, { running: ProjectOperationView | null; conflict: boolean }>();
  if (projectIds.length === 0) return out;
  const running = await db
    .select({ id: operations.id, projectId: operations.projectId, kind: operations.kind, status: operations.status, progress: operations.progress, title: operations.title })
    .from(operations)
    .where(and(inArray(operations.projectId, projectIds), inArray(operations.status, ['queued', 'running']), inArray(operations.kind, ['clone', ...SYNC_OPERATION_KINDS])))
    .orderBy(desc(operations.createdAt));
  for (const row of running) {
    if (!row.projectId || out.get(row.projectId)?.running) continue;
    out.set(row.projectId, { running: { id: row.id, kind: row.kind, status: row.status, progress: row.progress, title: row.title }, conflict: false });
  }
  // Last finished pull per project: a PULL_CONFLICT not followed by a successful pull = « Conflit à résoudre ».
  const pulls = await db
    .selectDistinctOn([operations.projectId], { projectId: operations.projectId, status: operations.status, error: operations.error })
    .from(operations)
    .where(and(inArray(operations.projectId, projectIds), eq(operations.kind, 'pull'), inArray(operations.status, ['succeeded', 'failed'])))
    .orderBy(operations.projectId, desc(operations.createdAt));
  for (const row of pulls) {
    if (!row.projectId) continue;
    const reason = (row.error as { reason?: string } | null)?.reason;
    const conflict = row.status === 'failed' && reason === 'PULL_CONFLICT';
    const entry = out.get(row.projectId) ?? { running: null, conflict: false };
    entry.conflict = conflict;
    out.set(row.projectId, entry);
  }
  return out;
}

export function toListItem(
  row: ProjectRow,
  counts: (ProjectSessionCounts & { lastActivityAt: Date | null }) | undefined,
  op: { running: ProjectOperationView | null; conflict: boolean } | undefined,
): ProjectListItem {
  const candidates = [row.lastOpenedAt, row.lastSyncedAt, counts?.lastActivityAt ?? null, row.createdAt].filter(
    (value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()),
  );
  const last = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;
  const running = op?.running ?? null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    fullName: row.githubFullName,
    htmlUrl: row.htmlUrl ?? `https://github.com/${row.githubFullName}`,
    path: row.path,
    status: row.status,
    statusDetail: row.statusDetail,
    favorite: row.isFavorite,
    archivedAt: iso(row.archivedAt),
    branch: row.currentBranch ?? null,
    defaultBranch: row.defaultBranch,
    sync: {
      state: row.syncState,
      ahead: row.aheadBy,
      behind: row.behindBy,
      syncing: Boolean(running && running.kind !== 'clone'),
      conflict: Boolean(op?.conflict),
    },
    sessions: counts
      ? { active: counts.active, interrupted: counts.interrupted, finished: counts.finished, total: counts.total }
      : emptyCounts(),
    lastActivityAt: iso(last),
    createdAt: row.createdAt.toISOString(),
    operation: running,
  };
}

export async function loadListItem(row: ProjectRow): Promise<ProjectListItem> {
  const [counts, ops] = await Promise.all([sessionCountsByProject([row.id]), operationStateByProject([row.id])]);
  return toListItem(row, counts.get(row.id), ops.get(row.id));
}

/** Sessions of one project for the D04 tile / « Sessions » tab (read-only, most recent first). */
export async function listProjectSessionRows(projectId: string, limit = 50): Promise<ProjectSessionView[]> {
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      status: sessions.status,
      branch: worktrees.branch,
      worktreeName: worktrees.name,
      worktreePresent: sql<boolean>`(${worktrees.id} is not null and ${worktrees.removedAt} is null)`,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      lastActivityAt: sessions.lastActivityAt,
      createdAt: sessions.createdAt,
      transcriptPath: sessions.transcriptPath,
    })
    .from(sessions)
    .leftJoin(worktrees, eq(worktrees.id, sessions.worktreeId))
    .where(and(eq(sessions.projectId, projectId), ne(sessions.status, 'archived'), isNull(sessions.archivedAt)))
    .orderBy(sql`case when ${sessions.status} in ('running','waiting_permission','waiting_input') then 0 else 1 end`, sql`coalesce(${sessions.lastActivityAt}, ${sessions.createdAt}) desc`)
    .limit(Math.min(Math.max(limit, 1), 200));
  const ids = rows.filter((row) => row.status === 'waiting_permission').map((row) => row.id);
  const pending = ids.length
    ? await db
        .select({ id: permissionRequests.id, sessionId: permissionRequests.sessionId })
        .from(permissionRequests)
        .where(and(inArray(permissionRequests.sessionId, ids), eq(permissionRequests.status, 'pending')))
    : [];
  const pendingBySession = new Map(pending.map((row) => [row.sessionId, row.id]));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    branch: row.branch ?? null,
    worktreeName: row.worktreeName ?? null,
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    lastActivityAt: iso(row.lastActivityAt),
    createdAt: row.createdAt.toISOString(),
    pendingPermissionId: pendingBySession.get(row.id) ?? null,
    // Same rule as the runner (`resumable`): ended — the worktree is recreated and a lost
    // conversation restarts with a new context (an archived project is not listed here).
    resumable: ['interrupted', 'stopped', 'failed', 'finished'].includes(row.status),
  }));
}

type RunRow = typeof commandRuns.$inferSelect & { worktreeName: string | null };

export function toRunView(row: RunRow): RunView {
  const counts = row.details?.report?.counts;
  return {
    id: row.id,
    kind: row.kind,
    command: row.command,
    status: row.status,
    exitCode: row.exitCode,
    port: row.port,
    summary: row.summary,
    worktreeId: row.worktreeId,
    worktreeName: row.worktreeName,
    name: row.kind === 'dev' ? (row.details?.devServer ?? DEFAULT_DEV_SERVER_NAME) : null,
    startedAt: row.startedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
    tests: counts ? { passed: counts.passed, failed: counts.failed, skipped: counts.skipped, total: counts.total } : null,
  };
}

/** Recent runs of a project (or of one worktree), most recent first. */
export async function listRunRows(projectId: string, options: { worktreeId?: string; kind?: CommandKind; limit?: number } = {}): Promise<RunView[]> {
  const rows = await db
    .select({ run: commandRuns, worktreeName: worktrees.name })
    .from(commandRuns)
    .leftJoin(worktrees, eq(worktrees.id, commandRuns.worktreeId))
    .where(
      and(
        eq(commandRuns.projectId, projectId),
        options.worktreeId ? eq(commandRuns.worktreeId, options.worktreeId) : undefined,
        options.kind ? eq(commandRuns.kind, options.kind) : undefined,
      ),
    )
    .orderBy(desc(commandRuns.startedAt))
    .limit(Math.min(Math.max(options.limit ?? 30, 1), 200));
  return rows.map((row) => toRunView({ ...row.run, worktreeName: row.worktreeName }));
}

/** Latest run per command kind (D04 badges), from the last 200 runs. */
export async function latestRunsByKind(projectId: string): Promise<{ latest: Partial<Record<string, RunView>>; recent: RunView[] }> {
  const recent = await listRunRows(projectId, { limit: 200 });
  const latest: Partial<Record<string, RunView>> = {};
  for (const run of recent) if (!latest[run.kind]) latest[run.kind] = run;
  return { latest, recent: recent.slice(0, 20) };
}
