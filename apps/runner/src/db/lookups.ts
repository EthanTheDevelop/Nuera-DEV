import { and, eq, isNull } from 'drizzle-orm';
import { appSettings, projects, worktrees, type Database } from '@nuera/db';
import type { WorktreeDto } from '@nuera/shared/runner';
import { RunnerError } from '../errors';

export type ProjectRow = typeof projects.$inferSelect;
export type WorktreeRow = typeof worktrees.$inferSelect;
export type AppSettingsRow = typeof appSettings.$inferSelect;

export async function getProject(db: Database, projectId: string): Promise<ProjectRow> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!row) throw new RunnerError('NOT_FOUND', 'Projet introuvable.');
  return row;
}

export async function getReadyProject(db: Database, projectId: string): Promise<ProjectRow> {
  const project = await getProject(db, projectId);
  if (project.status !== 'ready') {
    throw new RunnerError('CONFLICT', project.status === 'cloning' ? 'Le projet est en cours de clonage.' : "Le projet n'est pas prêt.", {
      reason: 'PROJECT_NOT_READY',
    });
  }
  return project;
}

export async function getWorktree(db: Database, worktreeId: string): Promise<WorktreeRow> {
  const [row] = await db.select().from(worktrees).where(eq(worktrees.id, worktreeId)).limit(1);
  if (!row || row.status === 'removed') throw new RunnerError('NOT_FOUND', 'Worktree introuvable.');
  return row;
}

export async function findPrimaryWorktree(db: Database, projectId: string): Promise<WorktreeRow | null> {
  const [row] = await db
    .select()
    .from(worktrees)
    .where(and(eq(worktrees.projectId, projectId), eq(worktrees.isPrimary, true), isNull(worktrees.removedAt)))
    .limit(1);
  return row ?? null;
}

/** Primary worktree row of a ready project (created on the fly for projects cloned elsewhere). */
export async function ensurePrimaryWorktree(db: Database, project: ProjectRow, branch: string | null): Promise<WorktreeRow> {
  const existing = await findPrimaryWorktree(db, project.id);
  if (existing) return existing;
  const [row] = await db
    .insert(worktrees)
    .values({
      projectId: project.id,
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

export async function listActiveWorktrees(db: Database, projectId: string): Promise<WorktreeRow[]> {
  return db
    .select()
    .from(worktrees)
    .where(and(eq(worktrees.projectId, projectId), isNull(worktrees.removedAt)));
}

export async function readAppSettings(db: Database): Promise<AppSettingsRow | null> {
  try {
    const [row] = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
    return row ?? null;
  } catch {
    return null;
  }
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
