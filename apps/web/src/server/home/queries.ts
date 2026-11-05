import 'server-only';
import { operations, permissionRequests, projects, pullRequests, sessions, worktrees } from '@nuera/db/schema';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { HomePendingPermission, HomeProject } from '@/features/home/types';
import { HOME_ACTIVE_STATUSES } from '@/features/home/lib';
import { db } from '@/server/db';

/**
 * Read-only queries of the Accueil (no writes, no runner). The session lists themselves come from
 * the Sessions lot (`@/server/sessions`); these cover what only the dashboard shows.
 */

/** Pending permission requests of the active sessions, oldest first (bounded). */
export async function loadPendingPermissions(limit = 20): Promise<HomePendingPermission[]> {
  const rows = await db
    .select({
      id: permissionRequests.id,
      sessionId: permissionRequests.sessionId,
      toolName: permissionRequests.toolName,
      title: permissionRequests.title,
      target: permissionRequests.target,
      createdAt: permissionRequests.createdAt,
      sessionTitle: sessions.title,
      projectName: projects.name,
    })
    .from(permissionRequests)
    .innerJoin(sessions, eq(sessions.id, permissionRequests.sessionId))
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(
      and(
        eq(permissionRequests.status, 'pending'),
        inArray(sessions.status, [...HOME_ACTIVE_STATUSES]),
        isNull(sessions.archivedAt),
      ),
    )
    .orderBy(asc(permissionRequests.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    sessionTitle: row.sessionTitle,
    projectName: row.projectName,
    target: row.target,
    isCommand: row.toolName === 'Bash',
    title: row.title,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Last activity of a project: opened, synchronised, committed, a session touched it, or created. */
const projectActivity = sql<Date>`greatest(
  ${projects.lastOpenedAt},
  ${projects.lastSyncedAt},
  ${projects.lastCommitAt},
  (select max(coalesce(s.last_activity_at, s.started_at, s.created_at)) from ${sessions} s where s.project_id = ${projects.id}),
  ${projects.createdAt}
)`;

export interface RecentProjectRow extends HomeProject {
  status: 'cloning' | 'ready' | 'error' | 'archived';
  htmlUrl: string | null;
  defaultBranch: string;
}

/** `Projets récents`: non-archived projects, most recent activity first. */
export async function loadRecentProjects(limit = 4): Promise<{ items: RecentProjectRow[]; total: number }> {
  const [rows, [count], running] = await Promise.all([
    db
      .select({
        id: projects.id,
        name: projects.name,
        fullName: projects.githubFullName,
        htmlUrl: projects.htmlUrl,
        status: projects.status,
        defaultBranch: projects.defaultBranch,
        currentBranch: projects.currentBranch,
        syncState: projects.syncState,
        aheadBy: projects.aheadBy,
        behindBy: projects.behindBy,
        isFavorite: projects.isFavorite,
        activity: sql<string>`to_char(${projectActivity} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      })
      .from(projects)
      .where(isNull(projects.archivedAt))
      .orderBy(desc(projectActivity), asc(projects.name))
      .limit(limit),
    db.select({ n: sql<number>`count(*)::int` }).from(projects).where(isNull(projects.archivedAt)),
    db
      .selectDistinct({ projectId: operations.projectId })
      .from(operations)
      .where(and(inArray(operations.status, ['queued', 'running']), inArray(operations.kind, ['clone', 'fetch', 'pull']), isNotNull(operations.projectId))),
  ]);
  const syncing = new Set(running.map((r) => r.projectId));
  return {
    total: Number(count?.n ?? 0),
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      fullName: row.fullName,
      htmlUrl: row.htmlUrl,
      status: row.status,
      defaultBranch: row.defaultBranch,
      branch: row.currentBranch ?? (row.status === 'ready' ? row.defaultBranch : null),
      sync: {
        state: row.syncState,
        ahead: row.aheadBy,
        behind: row.behindBy,
        syncing: row.status === 'cloning' || syncing.has(row.id),
      },
      favorite: row.isFavorite,
      lastActivityAt: row.activity && !Number.isNaN(Date.parse(row.activity)) ? row.activity : null,
    })),
  };
}

export interface LogTarget {
  projectId: string;
  projectName: string;
  htmlUrl: string | null;
  fullName: string;
  /** null = primary clone (HEAD). */
  worktreeId: string | null;
  branch: string | null;
}

/** Session worktrees (non-primary, still on disk) of non-archived ready projects: committed ones first, then recent. */
export async function loadRecentWorktrees(limit = 3): Promise<LogTarget[]> {
  const rows = await db
    .select({
      worktreeId: worktrees.id,
      branch: worktrees.branch,
      projectId: projects.id,
      projectName: projects.name,
      htmlUrl: projects.htmlUrl,
      fullName: projects.githubFullName,
    })
    .from(worktrees)
    .innerJoin(projects, eq(projects.id, worktrees.projectId))
    .where(
      and(
        eq(worktrees.isPrimary, false),
        eq(worktrees.status, 'active'),
        isNull(worktrees.removedAt),
        isNull(projects.archivedAt),
        eq(projects.status, 'ready'),
      ),
    )
    // Worktrees where Nuera Dev recorded a commit come first (their branch has history of its own),
    // then the most recently used ones.
    .orderBy(
      sql`(select max(o.finished_at) from ${operations} o where o.worktree_id = ${worktrees.id} and o.kind = 'commit' and o.status = 'succeeded') desc nulls last`,
      sql`coalesce(${worktrees.lastUsedAt}, ${worktrees.createdAt}) desc`,
    )
    .limit(limit);
  return rows.map((row) => ({ ...row }));
}

/** SHAs committed from a Nuera Dev session (runner `commit` with a session id) — « par Claude Code ». */
export async function loadSessionCommitShas(limit = 300): Promise<Set<string>> {
  const rows = await db
    .select({ sha: sql<string | null>`${operations.result}->>'sha'` })
    .from(operations)
    .where(and(eq(operations.kind, 'commit'), eq(operations.status, 'succeeded'), isNotNull(operations.sessionId)))
    .orderBy(desc(operations.createdAt))
    .limit(limit);
  return new Set(rows.map((r) => r.sha).filter((sha): sha is string => typeof sha === 'string' && sha.length >= 7));
}

export interface PullRequestRow {
  id: string;
  projectId: string;
  projectName: string;
  number: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  at: string;
}

/** Pull requests opened through Nuera Dev (rows written by the PR flow), latest first. */
export async function loadRecentPullRequests(limit = 4): Promise<PullRequestRow[]> {
  const rows = await db
    .select({
      id: pullRequests.id,
      projectId: pullRequests.projectId,
      projectName: projects.name,
      number: pullRequests.number,
      title: pullRequests.title,
      headBranch: pullRequests.headBranch,
      baseBranch: pullRequests.baseBranch,
      url: pullRequests.url,
      state: pullRequests.state,
      createdAt: pullRequests.createdAt,
      updatedAt: pullRequests.updatedAt,
    })
    .from(pullRequests)
    .innerJoin(projects, eq(projects.id, pullRequests.projectId))
    .where(isNull(projects.archivedAt))
    .orderBy(desc(pullRequests.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    projectName: row.projectName,
    number: row.number,
    title: row.title,
    headBranch: row.headBranch,
    baseBranch: row.baseBranch,
    url: row.url,
    state: row.state,
    // Opened → when it was opened; merged / closed → when that happened (last update).
    at: (row.state === 'open' ? row.createdAt : row.updatedAt).toISOString(),
  }));
}

