import 'server-only';
import { projects } from '@nuera/db/schema';
import { asc, desc, eq, isNull } from 'drizzle-orm';
import type {
  NewSessionOptions,
  NewSessionProject,
  ProjectBranchOption,
  ProjectBranchOptions,
} from '@/features/sessions/lib/contract';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { isRunnerUnavailable, runner } from '@/server/runner/client';
import { getAppSettings } from '@/server/settings';
import { getCapacity } from './queries';

/** Data of the « Nouvelle session » dialog: projects, Paramètres defaults, capacity. */

const PROJECT_STATUS_REASON: Record<string, string> = {
  cloning: 'Clonage en cours sur VPS-3.',
  error: 'Le projet est en erreur : voir sa page.',
};

export async function getNewSessionOptions(): Promise<NewSessionOptions> {
  const settings = await getAppSettings();
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      fullName: projects.githubFullName,
      defaultBranch: projects.defaultBranch,
      currentBranch: projects.currentBranch,
      options: projects.options,
      status: projects.status,
    })
    .from(projects)
    .where(isNull(projects.archivedAt))
    .orderBy(desc(projects.isFavorite), desc(projects.lastOpenedAt), asc(projects.name));
  const list: NewSessionProject[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    currentBranch: row.currentBranch,
    worktreePerSession: row.options?.worktreePerSession ?? true,
    ready: row.status === 'ready',
    unavailableReason: row.status === 'ready' ? null : (PROJECT_STATUS_REASON[row.status] ?? "Le projet n'est pas prêt."),
  }));
  const capacity = await getCapacity();
  return {
    projects: list,
    defaults: {
      permissionMode:
        settings.blockBypassPermissions && settings.defaultPermissionMode === 'bypassPermissions' ? 'manual' : settings.defaultPermissionMode,
      model: settings.defaultModel,
      effort: settings.defaultEffort,
      remoteControl: settings.remoteControlByDefault,
      blockBypassPermissions: settings.blockBypassPermissions,
    },
    capacity,
    runnerUnavailable: capacity.source === 'database',
  };
}

/**
 * Branches of a project for the dialog (runner `listBranches`): local and remote merged by name,
 * the one already in a worktree with a live session marked busy.
 */
export async function getProjectBranchOptions(projectId: string): Promise<ProjectBranchOptions> {
  const [project] = await db
    .select({ id: projects.id, status: projects.status, archivedAt: projects.archivedAt, currentBranch: projects.currentBranch })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project || project.archivedAt) throw new AppError('NOT_FOUND', 'Projet introuvable.');
  if (project.status !== 'ready') throw new AppError('CONFLICT', "Le projet n'est pas prêt : attendez la fin du clonage.");
  const result = await runner.listBranches({ params: { projectId }, query: {} }, { timeoutMs: 20_000 });
  const byName = new Map<string, ProjectBranchOption>();
  let currentBranch: string | null = project.currentBranch;
  for (const branch of result.branches) {
    if (branch.kind === 'local' && branch.current) currentBranch = branch.name;
    const existing = byName.get(branch.name);
    if (existing && existing.kind === 'local') continue;
    byName.set(branch.name, {
      name: branch.name,
      kind: branch.kind,
      isDefault: branch.isDefault,
      protected: branch.protected,
      current: branch.kind === 'local' && branch.current,
      worktreeName: branch.worktreeName,
      busySessionId: branch.sessionId,
    });
  }
  const branches = [...byName.values()].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  let primaryBusy = false;
  try {
    const live = await runner.listSessions(undefined, { timeoutMs: 5_000 });
    primaryBusy = live.sessions.some((s) => s.projectId === projectId && s.live && s.worktree?.isPrimary);
  } catch (error) {
    if (!isRunnerUnavailable(error)) throw error;
  }
  return { projectId, defaultBranch: result.defaultBranch, currentBranch, branches, primaryBusy };
}
