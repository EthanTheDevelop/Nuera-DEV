import 'server-only';
import { projects, sessions, worktrees } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import type { RequestContext } from '@/server/tenancy/context';
import { NOT_FOUND_MESSAGES, scopeOfSession, scopeOfWorktree, type SessionScope, type WorktreeScope } from '@/server/tenancy/scope';

/**
 * Database reads that scope every Workspace call (docs/MULTICOMPTE.md §5): a session belongs to a
 * live (not archived) project OF THE SPACE; a worktree id must be a worktree row of such a project.
 * The space is in the WHERE clause of the first query (`scopeOf*()`): an id of another space is
 * refused exactly like an unknown id, before any runner call. The scope gives the runner client of
 * the server holding the project. The runner confines the paths again (`realpath`).
 */

export type ProjectRow = typeof projects.$inferSelect;
export type WorktreeRow = typeof worktrees.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

export interface SessionContext {
  scope: SessionScope;
  session: SessionRow;
  project: ProjectRow;
  worktree: WorktreeRow | null;
}

/**
 * Session + project + worktree of the space, or null when the id is unknown, belongs to another
 * space or its project is archived.
 */
export async function findSessionContext(ctx: Pick<RequestContext, 'space'>, sessionId: string): Promise<SessionContext | null> {
  let scope: SessionScope;
  try {
    scope = await scopeOfSession(ctx, sessionId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
  if (scope.projectArchivedAt) return null;
  const [row] = await db
    .select({ session: sessions, project: projects })
    .from(sessions)
    .innerJoin(projects, and(eq(projects.id, sessions.projectId), eq(projects.environmentId, sessions.environmentId)))
    .where(and(eq(sessions.id, scope.sessionId), eq(projects.spaceId, ctx.space.id)))
    .limit(1);
  if (!row || row.project.archivedAt) return null;
  let worktree: WorktreeRow | null = null;
  if (row.session.worktreeId) {
    const [wt] = await db
      .select()
      .from(worktrees)
      .where(and(eq(worktrees.id, row.session.worktreeId), eq(worktrees.projectId, row.project.id)))
      .limit(1);
    worktree = wt ?? null;
  }
  return { scope, session: row.session, project: row.project, worktree };
}

export async function requireSessionContext(ctx: Pick<RequestContext, 'space'>, sessionId: string): Promise<SessionContext> {
  const context = await findSessionContext(ctx, sessionId);
  if (!context) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGES.session);
  return context;
}

export interface WorktreeContext {
  scope: WorktreeScope;
  worktree: WorktreeRow;
  project: ProjectRow;
}

/**
 * Worktree of a non-archived project of the space, still present (removed worktrees cannot be
 * read: CONFLICT, only once the space is checked).
 */
export async function requireWorktreeContext(ctx: Pick<RequestContext, 'space'>, worktreeId: string): Promise<WorktreeContext> {
  const scope = await scopeOfWorktree(ctx, worktreeId);
  if (scope.projectArchivedAt) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGES.worktree);
  const [row] = await db
    .select({ worktree: worktrees, project: projects })
    .from(worktrees)
    .innerJoin(projects, and(eq(projects.id, worktrees.projectId), eq(projects.environmentId, worktrees.environmentId)))
    .where(and(eq(worktrees.id, scope.worktreeId), eq(projects.spaceId, ctx.space.id)))
    .limit(1);
  if (!row || row.project.archivedAt) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGES.worktree);
  if (row.worktree.removedAt || row.worktree.status === 'removed') {
    throw new AppError('CONFLICT', 'Ce worktree a été supprimé sur le serveur.', { untouched: "L'historique de la session reste lisible." });
  }
  return { scope, worktree: row.worktree, project: row.project };
}

/**
 * A `sessionId` sent with a Git action must be a session of that worktree (it is recorded with the
 * runner operation and in the audit journal): anything else is refused. The worktree is already
 * scoped, so a matching session is in the same space.
 */
export async function assertSessionOfWorktree(worktreeId: string, sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.worktreeId, worktreeId)))
    .limit(1);
  if (!row) throw new AppError('VALIDATION', "Cette session ne travaille pas dans ce worktree.", { untouched: "Rien n'a été modifié." });
}

/** Repository short name (`devis-express` from `atelier-test/devis-express`). */
export function repoName(fullName: string): string {
  const slash = fullName.lastIndexOf('/');
  return slash >= 0 ? fullName.slice(slash + 1) : fullName;
}

export function githubHtmlUrl(project: Pick<ProjectRow, 'htmlUrl' | 'githubFullName'>): string {
  return project.htmlUrl ?? `https://github.com/${project.githubFullName}`;
}
