import { and, eq, isNull } from 'drizzle-orm';
import { commandRuns, operations, permissionRequests, projects, sessions, worktrees, type Database } from '@nuera/db';
import type { WorktreeDto } from '@nuera/shared/runner';
import { RunnerError } from '../errors';

/**
 * Every lookup by id takes the server id IN THE QUERY (docs/MULTICOMPTE.md §4): a row of another
 * server answers exactly like an unknown id (same NOT_FOUND message), before any write.
 */

export type ProjectRow = typeof projects.$inferSelect;
export type WorktreeRow = typeof worktrees.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type PermissionRow = typeof permissionRequests.$inferSelect;
export type OperationRow = typeof operations.$inferSelect;
export type RunRow = typeof commandRuns.$inferSelect;

export async function getProject(db: Database, environmentId: string, projectId: string): Promise<ProjectRow> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.environmentId, environmentId)))
    .limit(1);
  if (!row) throw new RunnerError('NOT_FOUND', 'Projet introuvable.');
  return row;
}

export async function getReadyProject(db: Database, environmentId: string, projectId: string): Promise<ProjectRow> {
  const project = await getProject(db, environmentId, projectId);
  if (project.status !== 'ready') {
    throw new RunnerError('CONFLICT', project.status === 'cloning' ? 'Le projet est en cours de clonage.' : "Le projet n'est pas prêt.", {
      reason: 'PROJECT_NOT_READY',
    });
  }
  return project;
}

export async function getWorktree(db: Database, environmentId: string, worktreeId: string): Promise<WorktreeRow> {
  const [row] = await db
    .select()
    .from(worktrees)
    .where(and(eq(worktrees.id, worktreeId), eq(worktrees.environmentId, environmentId)))
    .limit(1);
  if (!row || row.status === 'removed') throw new RunnerError('NOT_FOUND', 'Worktree introuvable.');
  return row;
}

export async function findSessionRow(db: Database, environmentId: string, sessionId: string): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.environmentId, environmentId)))
    .limit(1);
  return row ?? null;
}

export async function getSessionRow(db: Database, environmentId: string, sessionId: string): Promise<SessionRow> {
  const row = await findSessionRow(db, environmentId, sessionId);
  if (!row) throw new RunnerError('NOT_FOUND', 'Session introuvable.');
  return row;
}

/** A permission request belongs to the server of its session (joined, never trusted alone). */
export async function getPermissionRow(db: Database, environmentId: string, permissionId: string): Promise<PermissionRow> {
  const [row] = await db
    .select({ permission: permissionRequests })
    .from(permissionRequests)
    .innerJoin(sessions, eq(sessions.id, permissionRequests.sessionId))
    .where(and(eq(permissionRequests.id, permissionId), eq(sessions.environmentId, environmentId)))
    .limit(1);
  if (!row) throw new RunnerError('NOT_FOUND', "Demande d'autorisation introuvable.");
  return row.permission;
}

export async function findOperationRow(db: Database, environmentId: string, operationId: string): Promise<OperationRow | null> {
  const [row] = await db
    .select()
    .from(operations)
    .where(and(eq(operations.id, operationId), eq(operations.environmentId, environmentId)))
    .limit(1);
  return row ?? null;
}

export async function getRunRow(db: Database, environmentId: string, runId: string): Promise<RunRow> {
  const [row] = await db
    .select()
    .from(commandRuns)
    .where(and(eq(commandRuns.id, runId), eq(commandRuns.environmentId, environmentId)))
    .limit(1);
  if (!row) throw new RunnerError('NOT_FOUND', 'Lancement introuvable.');
  return row;
}

export async function findPrimaryWorktree(db: Database, project: ProjectRow): Promise<WorktreeRow | null> {
  const [row] = await db
    .select()
    .from(worktrees)
    .where(
      and(
        eq(worktrees.projectId, project.id),
        eq(worktrees.environmentId, project.environmentId),
        eq(worktrees.isPrimary, true),
        isNull(worktrees.removedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Primary worktree row of a ready project (created on the fly for projects cloned elsewhere). */
export async function ensurePrimaryWorktree(db: Database, project: ProjectRow, branch: string | null): Promise<WorktreeRow> {
  const existing = await findPrimaryWorktree(db, project);
  if (existing) return existing;
  const [row] = await db
    .insert(worktrees)
    .values({
      projectId: project.id,
      environmentId: project.environmentId,
      name: project.slug,
      branch: branch ?? project.currentBranch ?? project.defaultBranch,
      baseBranch: null,
      path: project.path,
      isPrimary: true,
      status: 'active',
    })
    .returning();
  if (!row) throw new RunnerError('INTERNAL', 'Worktree principal non enregistré.');
  return row;
}

export async function listActiveWorktrees(db: Database, project: ProjectRow): Promise<WorktreeRow[]> {
  return db
    .select()
    .from(worktrees)
    .where(and(eq(worktrees.projectId, project.id), eq(worktrees.environmentId, project.environmentId), isNull(worktrees.removedAt)));
}

export function worktreeRowToDto(
  row: WorktreeRow,
  live: { dirtyFiles: number | null; ahead: number | null; behind: number | null; liveSessionId: string | null },
): WorktreeDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    branch: row.branch,
    baseBranch: row.baseBranch,
    path: row.path,
    isPrimary: row.isPrimary,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    ...live,
  };
}
