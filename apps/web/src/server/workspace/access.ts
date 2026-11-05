import 'server-only';
import { projects, sessions, worktrees } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';

/**
 * Database reads that scope every Workspace call: a session belongs to a live (not archived)
 * project; a worktree id must be a worktree row of such a project. The runner confines the paths
 * again (`realpath`), the web only refuses ids it does not know.
 */

export type ProjectRow = typeof projects.$inferSelect;
export type WorktreeRow = typeof worktrees.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

export interface SessionContext {
  session: SessionRow;
  project: ProjectRow;
  worktree: WorktreeRow | null;
}

/** Session + project + worktree, or null when the id is unknown or its project is archived. */
export async function findSessionContext(sessionId: string): Promise<SessionContext | null> {
  const [row] = await db
    .select({ session: sessions, project: projects })
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row || row.project.archivedAt) return null;
  let worktree: WorktreeRow | null = null;
  if (row.session.worktreeId) {
    const [wt] = await db.select().from(worktrees).where(eq(worktrees.id, row.session.worktreeId)).limit(1);
    worktree = wt ?? null;
  }
  return { session: row.session, project: row.project, worktree };
}

export async function requireSessionContext(sessionId: string): Promise<SessionContext> {
  const context = await findSessionContext(sessionId);
  if (!context) throw new AppError('NOT_FOUND', 'Session introuvable.');
  return context;
}

export interface WorktreeContext {
  worktree: WorktreeRow;
  project: ProjectRow;
}

/** Worktree of a non-archived project, still present (removed worktrees cannot be read). */
export async function requireWorktreeContext(worktreeId: string): Promise<WorktreeContext> {
  const [row] = await db
    .select({ worktree: worktrees, project: projects })
    .from(worktrees)
    .innerJoin(projects, eq(projects.id, worktrees.projectId))
    .where(eq(worktrees.id, worktreeId))
    .limit(1);
  if (!row || row.project.archivedAt) throw new AppError('NOT_FOUND', 'Worktree introuvable.');
  if (row.worktree.removedAt || row.worktree.status === 'removed') {
    throw new AppError('CONFLICT', 'Ce worktree a été supprimé sur le serveur.', { untouched: "L'historique de la session reste lisible." });
  }
  return row;
}

/** Repository short name (`devis-express` from `atelier-test/devis-express`). */
export function repoName(fullName: string): string {
  const slash = fullName.lastIndexOf('/');
  return slash >= 0 ? fullName.slice(slash + 1) : fullName;
}

export function githubHtmlUrl(project: Pick<ProjectRow, 'htmlUrl' | 'githubFullName'>): string {
  return project.htmlUrl ?? `https://github.com/${project.githubFullName}`;
}
