import 'server-only';
import type { Branch, WorktreeDto } from '@nuera/shared/runner';
import { isValidBranchName } from '@nuera/shared/paths';
import { z } from 'zod';
import { AppError } from '@/server/errors';
import { listProtectedBranches } from '@/server/github';
import { RunnerError } from '@/server/runner/client';
import { auditIn, scopeOfWorktree } from '@/server/tenancy/scope';
import { requireProject, type ProjectContext, type ProjectHandle } from './access';
import { withSyncCopy } from './errors';
import type { BranchView, BranchesView, WorktreeRemovalPreview, WorktreeView } from './types';

export const branchNameSchema = z
  .string()
  .trim()
  .min(1, 'nom requis')
  .max(250)
  .refine(isValidBranchName, { message: "nom de branche invalide (pas d'espace, ni « .. », ni caractère spécial Git)" });

export const createBranchInputSchema = z.object({
  name: branchNameSchema,
  /** Start point (default: the project's default branch). */
  from: branchNameSchema.optional(),
  /** Switch the primary clone to the new branch. */
  checkout: z.boolean().default(false),
});
export const checkoutInputSchema = z.object({ branch: branchNameSchema });
export const removeWorktreeInputSchema = z.object({
  /** Remove even with uncommitted files (only after the typed confirmation of the T8 dialog). */
  force: z.boolean().default(false),
  /** Also delete the local branch when it is merged (git never deletes an unmerged one). */
  deleteBranch: z.boolean().default(false),
});

function toBranchView(branch: Branch): BranchView {
  return {
    name: branch.name,
    kind: branch.kind,
    current: branch.current,
    protected: branch.protected,
    merged: branch.merged,
    isDefault: branch.isDefault,
    upstream: branch.upstream,
    ahead: branch.ahead,
    behind: branch.behind,
    committedAt: branch.committedAt,
    subject: branch.subject,
    worktreeId: branch.worktreeId,
    worktreeName: branch.worktreeName,
    sessionId: branch.sessionId,
  };
}

/**
 * Local branches (current first, then active sessions, default, most recent commit) and the remote
 * branches that have no local counterpart. `origin/HEAD` is already skipped by the runner.
 */
export function shapeBranches(defaultBranch: string, branches: Branch[]): BranchesView {
  const local = branches.filter((branch) => branch.kind === 'local');
  const localNames = new Set(local.map((branch) => branch.name));
  const remoteOnly = branches.filter((branch) => branch.kind === 'remote' && branch.remote === 'origin' && !localNames.has(branch.name));
  const time = (branch: Branch) => (branch.committedAt ? Date.parse(branch.committedAt) || 0 : 0);
  const rank = (branch: Branch) => (branch.current ? 0 : branch.sessionId ? 1 : branch.isDefault ? 2 : 3);
  local.sort((a, b) => rank(a) - rank(b) || time(b) - time(a) || a.name.localeCompare(b.name));
  remoteOnly.sort((a, b) => time(b) - time(a) || a.name.localeCompare(b.name));
  return { defaultBranch, items: [...local, ...remoteOnly].map(toBranchView) };
}

export async function listProjectBranches(ctx: ProjectContext, projectId: string): Promise<BranchesView> {
  const { row: project, runner } = await requireProject(ctx, projectId, { state: 'ready' });
  // « Protégée » = the default branch and the branches protected on GitHub (same list as the push),
  // read through the project's GitHub source.
  const protectedNames = await listProtectedBranches(project, project.defaultBranch);
  const result = await runner.listBranches({ params: { projectId: project.id }, query: { protected: protectedNames.join(',') } });
  return shapeBranches(result.defaultBranch, result.branches);
}

/** « Nouvelle branche » (D02 menu, D04 tile): created from the default branch unless `from` says otherwise. */
export async function createProjectBranch(ctx: ProjectContext, projectId: string, input: z.input<typeof createBranchInputSchema>) {
  const { row: project, runner, environment } = await requireProject(ctx, projectId, { state: 'ready' });
  const parsed = createBranchInputSchema.parse(input);
  const result = await runner
    .createBranch({ params: { projectId: project.id }, body: { name: parsed.name, ...(parsed.from ? { from: parsed.from } : {}), checkout: parsed.checkout, actorUserId: ctx.user.id } })
    .catch(withSyncCopy);
  await auditIn(ctx, {
    environmentId: environment.id,
    action: 'project.branch_created',
    summary: `branche ${parsed.name} créée dans ${project.name} depuis ${parsed.from ?? project.defaultBranch}${parsed.checkout ? ' (branche courante)' : ''}`,
    targetType: 'project',
    targetId: project.id,
    metadata: { branch: parsed.name, from: parsed.from ?? project.defaultBranch, checkout: parsed.checkout },
  });
  return result;
}

/** D04 branch selector: switches the primary clone (refused while a session works in it, or when dirty). */
export async function checkoutProjectBranch(ctx: ProjectContext, projectId: string, input: z.input<typeof checkoutInputSchema>) {
  const { row: project, runner, environment } = await requireProject(ctx, projectId, { state: 'ready' });
  const parsed = checkoutInputSchema.parse(input);
  const result = await runner
    .checkoutBranch({ params: { projectId: project.id }, body: { branch: parsed.branch, track: true, actorUserId: ctx.user.id } })
    .catch(withSyncCopy);
  await auditIn(ctx, {
    environmentId: environment.id,
    action: 'project.checkout',
    summary: `${project.name} passé sur la branche ${parsed.branch}`,
    targetType: 'project',
    targetId: project.id,
    metadata: { branch: parsed.branch, from: project.currentBranch },
  });
  return result;
}

export function toWorktreeView(worktree: WorktreeDto): WorktreeView {
  return {
    id: worktree.id,
    name: worktree.name,
    branch: worktree.branch,
    baseBranch: worktree.baseBranch,
    path: worktree.path,
    isPrimary: worktree.isPrimary,
    status: worktree.status,
    createdAt: worktree.createdAt,
    lastUsedAt: worktree.lastUsedAt,
    dirtyFiles: worktree.dirtyFiles,
    ahead: worktree.ahead,
    behind: worktree.behind,
    liveSessionId: worktree.liveSessionId,
  };
}

async function readWorktrees(handle: ProjectHandle): Promise<WorktreeView[]> {
  const { worktrees } = await handle.runner.listWorktrees({ params: { projectId: handle.row.id } });
  return worktrees.filter((worktree) => worktree.status !== 'removed').map(toWorktreeView);
}

export async function listProjectWorktrees(ctx: ProjectContext, projectId: string): Promise<WorktreeView[]> {
  return readWorktrees(await requireProject(ctx, projectId, { state: 'ready' }));
}

const WORKTREE_GONE = 'Worktree introuvable : il a peut-être déjà été supprimé.';

/**
 * The worktree of the project, as its server sees it. The worktree is first checked in the
 * database (in the space AND in that project), so a foreign or mismatched id never reaches the
 * runner.
 */
async function findWorktree(ctx: ProjectContext, handle: ProjectHandle, worktreeId: string): Promise<WorktreeView> {
  const scope = await scopeOfWorktree(ctx, worktreeId, { notFound: WORKTREE_GONE });
  if (scope.projectId !== handle.row.id) throw new AppError('NOT_FOUND', WORKTREE_GONE);
  const worktree = (await readWorktrees(handle)).find((item) => item.id === worktreeId);
  if (!worktree) throw new AppError('NOT_FOUND', WORKTREE_GONE);
  return worktree;
}

/** T8: what removing this worktree keeps and loses (uncommitted files, live session). */
export async function previewWorktreeRemoval(ctx: ProjectContext, projectId: string, worktreeId: string): Promise<WorktreeRemovalPreview> {
  const handle = await requireProject(ctx, projectId, { state: 'ready' });
  const { runner } = handle;
  const worktree = await findWorktree(ctx, handle, worktreeId);
  let dirtyFiles: string[] = [];
  if ((worktree.dirtyFiles ?? 0) > 0) {
    try {
      const status = await runner.worktreeStatus({ params: { worktreeId } });
      dirtyFiles = status.files.filter((file) => file.kind !== 'ignored').map((file) => file.path).slice(0, 50);
    } catch {
      dirtyFiles = [];
    }
  }
  const blockedReason = worktree.isPrimary
    ? 'Le clone principal ne se supprime pas : archivez le projet.'
    : worktree.liveSessionId
      ? "Une session Claude travaille dans ce worktree : arrêtez-la d'abord."
      : null;
  return { worktree, dirtyFiles, canRemove: blockedReason === null, blockedReason };
}

/**
 * Removes a session worktree (T8). Without `force`, a worktree with uncommitted files is refused by
 * the runner (WORKTREE_DIRTY, files listed); the UI only sends `force` after the typed confirmation.
 * The branch is kept unless `deleteBranch` and it is merged.
 */
export async function removeProjectWorktree(ctx: ProjectContext, projectId: string, worktreeId: string, input: z.input<typeof removeWorktreeInputSchema>) {
  const handle = await requireProject(ctx, projectId, { state: 'ready' });
  const { row: project, runner } = handle;
  const parsed = removeWorktreeInputSchema.parse(input);
  const worktree = await findWorktree(ctx, handle, worktreeId);
  if (worktree.isPrimary) throw new AppError('VALIDATION', 'Le clone principal ne se supprime pas : archivez le projet.');
  let result;
  try {
    result = await runner.removeWorktree({ params: { worktreeId }, query: { force: parsed.force, deleteBranch: parsed.deleteBranch } });
  } catch (error) {
    if (error instanceof RunnerError && error.reason === 'WORKTREE_DIRTY') withSyncCopy(error);
    throw error;
  }
  await auditIn(ctx, {
    environmentId: handle.environment.id,
    action: 'project.worktree_removed',
    summary: `worktree ${worktree.name} (${worktree.branch}) supprimé de ${project.name}${parsed.force && (worktree.dirtyFiles ?? 0) > 0 ? `, ${worktree.dirtyFiles} fichier(s) non commité(s) abandonné(s)` : ''}${result.branchDeleted ? ', branche supprimée' : ', branche conservée'}`,
    targetType: 'worktree',
    targetId: worktree.id,
    metadata: { projectId: project.id, branch: worktree.branch, force: parsed.force, branchDeleted: result.branchDeleted },
  });
  return result;
}
