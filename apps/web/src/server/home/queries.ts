import 'server-only';
import { operations, permissionRequests, projects, pullRequests, sessions, worktrees } from '@nuera/db/schema';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { HomePendingPermission, HomeProject } from '@/features/home/types';
import { HOME_ACTIVE_STATUSES } from '@/features/home/lib';
import { db } from '@/server/db';
import type { RequestContext } from '@/server/tenancy/context';
import { ofSpace } from '@/server/tenancy/scope';

/**
 * Read-only queries of the Accueil (no writes, no runner), every one of them limited to the space
 * of the request context (`ofSpace`: projects.space_id), joined through the project for the rows
 * below it. The session lists themselves come from the Sessions lot (`@/server/sessions`); these
 * cover what only the dashboard shows.
 */

type SpaceContext = Pick<RequestContext, 'space'>;

/** Pending permission requests of the active sessions of the space, oldest first (bounded). */
export async function loadPendingPermissions(ctx: SpaceContext, limit = 20): Promise<HomePendingPermission[]> {
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
    .innerJoin(projects, and(eq(projects.id, sessions.projectId), eq(projects.environmentId, sessions.environmentId)))
    .where(
      ofSpace(
        ctx,
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

/**
 * `"projects"."id"`, always qualified: in a single-table select Drizzle renders `${projects.id}` as a
 * bare `"id"`, which a correlated subquery on `sessions s` would resolve to `s.id`.
 */
const PROJECT_ID = sql`${projects}.${sql.identifier(projects.id.name)}`;

/** Last activity of a project: opened, synchronised, committed, a session touched it, or created. */
const projectActivity = sql<Date>`greatest(
  ${projects.lastOpenedAt},
  ${projects.lastSyncedAt},
  ${projects.lastCommitAt},
  (select max(coalesce(s.last_activity_at, s.started_at, s.created_at)) from ${sessions} s where s.project_id = ${PROJECT_ID}),
  ${projects.createdAt}
)`;

export interface RecentProjectRow extends HomeProject {
  status: 'cloning' | 'ready' | 'error' | 'archived';
  htmlUrl: string | null;
  defaultBranch: string;
  /** Server holding the project (its runner reads the history). */
  environmentId: string;
}

/**
 * `Projets récents`: non-archived projects of the space, most recent activity first. `total` counts
 * the non-archived ones (0 = first run), `ever` every project of the space, archived included
 * (« Premiers pas » › « Ajouter un premier projet »), `sessionsEver` whether a Claude Code session has
 * already run in one of them (« Premiers pas » is then over for good).
 */
export async function loadRecentProjects(
  ctx: SpaceContext,
  limit = 4,
): Promise<{ items: RecentProjectRow[]; total: number; ever: number; sessionsEver: boolean }> {
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
        environmentId: projects.environmentId,
        activity: sql<string>`to_char(${projectActivity} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      })
      .from(projects)
      .where(ofSpace(ctx, isNull(projects.archivedAt)))
      .orderBy(desc(projectActivity), asc(projects.name))
      .limit(limit),
    db
      .select({
        n: sql<number>`count(*) filter (where ${projects.archivedAt} is null)::int`,
        ever: sql<number>`count(*)::int`,
        sessionsEver: sql<boolean>`coalesce(bool_or(exists (select 1 from ${sessions} s where s.project_id = ${PROJECT_ID})), false)`,
      })
      .from(projects)
      .where(ofSpace(ctx)),
    db
      .selectDistinct({ projectId: operations.projectId })
      .from(operations)
      .innerJoin(projects, eq(projects.id, operations.projectId))
      .where(ofSpace(ctx, inArray(operations.status, ['queued', 'running']), inArray(operations.kind, ['clone', 'fetch', 'pull']), isNotNull(operations.projectId))),
  ]);
  const syncing = new Set(running.map((r) => r.projectId));
  return {
    total: Number(count?.n ?? 0),
    ever: Number(count?.ever ?? 0),
    sessionsEver: count?.sessionsEver === true,
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      fullName: row.fullName,
      htmlUrl: row.htmlUrl,
      status: row.status,
      defaultBranch: row.defaultBranch,
      environmentId: row.environmentId,
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
  /** Server holding the project: `repoLog` goes to its runner. */
  environmentId: string;
  projectName: string;
  htmlUrl: string | null;
  fullName: string;
  /** null = primary clone (HEAD). */
  worktreeId: string | null;
  branch: string | null;
}

/** Session worktrees (non-primary, still on disk) of non-archived ready projects of the space: committed ones first, then recent. */
export async function loadRecentWorktrees(ctx: SpaceContext, limit = 3): Promise<LogTarget[]> {
  const rows = await db
    .select({
      worktreeId: worktrees.id,
      branch: worktrees.branch,
      projectId: projects.id,
      environmentId: projects.environmentId,
      projectName: projects.name,
      htmlUrl: projects.htmlUrl,
      fullName: projects.githubFullName,
    })
    .from(worktrees)
    .innerJoin(projects, and(eq(projects.id, worktrees.projectId), eq(projects.environmentId, worktrees.environmentId)))
    .where(
      ofSpace(
        ctx,
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

/** SHAs committed from a Nuera Dev session of the space (runner `commit` with a session id) — « par Claude Code ». */
export async function loadSessionCommitShas(ctx: SpaceContext, limit = 300): Promise<Set<string>> {
  const rows = await db
    .select({ sha: sql<string | null>`${operations.result}->>'sha'` })
    .from(operations)
    .innerJoin(projects, eq(projects.id, operations.projectId))
    .where(ofSpace(ctx, eq(operations.kind, 'commit'), eq(operations.status, 'succeeded'), isNotNull(operations.sessionId)))
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

/** Pull requests opened through Nuera Dev in the space (rows written by the PR flow), latest first. */
export async function loadRecentPullRequests(ctx: SpaceContext, limit = 4): Promise<PullRequestRow[]> {
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
    .where(ofSpace(ctx, isNull(projects.archivedAt)))
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

