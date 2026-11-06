import 'server-only';
import { environments, projects } from '@nuera/db/schema';
import { asc, desc, eq, isNull } from 'drizzle-orm';
import type {
  NewSessionOptions,
  NewSessionProject,
  ProjectBranchOption,
  ProjectBranchOptions,
} from '@/features/sessions/lib/contract';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { isRunnerUnavailable } from '@/server/runner/client';
import { getEffectiveSessionPolicy } from '@/server/settings';
import type { RequestContext } from '@/server/tenancy/context';
import { ofSpace } from '@/server/tenancy/scope';
import { readScopedProject } from './access';
import { getCapacity } from './queries';

/** Data of the « Nouvelle session » dialog: projects of the space, its defaults, capacity of its server. */

/** Why a project cannot host a session yet (`{serveur}` = the server holding the project). */
export function projectUnavailableReason(status: string, serverName: string): string {
  if (status === 'cloning') return `Clonage en cours sur ${serverName}.`;
  if (status === 'error') return 'Le projet est en erreur : voir sa page.';
  return "Le projet n'est pas prêt.";
}

export async function getNewSessionOptions(ctx: Pick<RequestContext, 'space' | 'environment'>): Promise<NewSessionOptions> {
  const policy = await getEffectiveSessionPolicy(ctx.space.id);
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      fullName: projects.githubFullName,
      defaultBranch: projects.defaultBranch,
      currentBranch: projects.currentBranch,
      options: projects.options,
      status: projects.status,
      serverName: environments.name,
    })
    .from(projects)
    .innerJoin(environments, eq(environments.id, projects.environmentId))
    .where(ofSpace(ctx, isNull(projects.archivedAt)))
    .orderBy(desc(projects.isFavorite), desc(projects.lastOpenedAt), asc(projects.name));
  const list: NewSessionProject[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    currentBranch: row.currentBranch,
    worktreePerSession: row.options?.worktreePerSession ?? true,
    ready: row.status === 'ready',
    unavailableReason: row.status === 'ready' ? null : projectUnavailableReason(row.status, row.serverName),
  }));
  const capacity = await getCapacity(ctx);
  return {
    projects: list,
    defaults: {
      permissionMode: policy.defaultPermissionMode,
      model: policy.defaultModel,
      effort: policy.defaultEffort,
      remoteControl: policy.remoteControlByDefault,
      blockBypassPermissions: policy.blockBypassPermissions,
    },
    capacity,
    runnerUnavailable: capacity.source === 'database',
    environment: capacity.environment,
  };
}

/**
 * Branches of a project of the space for the dialog (runner `listBranches` of the project's
 * server): local and remote merged by name, the one already in a worktree with a live session
 * marked busy.
 */
export async function getProjectBranchOptions(ctx: Pick<RequestContext, 'space'>, projectId: string): Promise<ProjectBranchOptions> {
  const { scope, project } = await readScopedProject(ctx, projectId);
  if (project.status !== 'ready') throw new AppError('CONFLICT', "Le projet n'est pas prêt : attendez la fin du clonage.");
  const result = await scope.runner.listBranches({ params: { projectId: project.id }, query: {} }, { timeoutMs: 20_000 });
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
    const live = await scope.runner.listSessions(undefined, { timeoutMs: 5_000 });
    primaryBusy = live.sessions.some((s) => s.projectId === project.id && s.live && s.worktree?.isPrimary);
  } catch (error) {
    if (!isRunnerUnavailable(error)) throw error;
  }
  return { projectId: project.id, defaultBranch: result.defaultBranch, currentBranch, branches, primaryBusy };
}
