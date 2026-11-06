import 'server-only';
import type { PullResult, SyncStatus } from '@nuera/shared/runner';
import { getGitAuthForProject } from '@/server/github';
import { RunnerError } from '@/server/runner/client';
import { auditIn } from '@/server/tenancy/scope';
import { requireProject, type ProjectContext } from './access';
import { withSyncCopy } from './errors';
import { loadListItem } from './queries';
import type { ProjectListItem } from './types';

export interface SyncProjectResult {
  /** `fast_forward` (N commits brought in), `up_to_date`, or `fetched` when the branch has no upstream. */
  outcome: PullResult['outcome'] | 'fetched';
  commits: number;
  sync: SyncStatus;
  project: ProjectListItem;
}

/**
 * « Synchroniser » (D02 row menu, D04 header, M04 refresh): `git fetch` then a fast-forward-only
 * pull of the primary clone on the project's server, both with a READ token of that repository
 * minted by the project's GitHub source. Never creates a commit: a diverged branch, a conflict or
 * local changes stop it with the T4 copy (what failed, what was not touched) and the runner reason
 * (PULL_DIVERGED, PULL_CONFLICT, PULL_DIRTY, GIT_CONFIG_UNSAFE…).
 */
export async function syncProject(ctx: ProjectContext, projectId: string): Promise<SyncProjectResult> {
  const handle = await requireProject(ctx, projectId, { state: 'ready' });
  const { row: project, runner } = handle;
  const environmentId = handle.environment.id;
  const { extraHeader } = await getGitAuthForProject(project, 'read');
  let result: { outcome: SyncProjectResult['outcome']; commits: number; sync: SyncStatus };
  try {
    const pulled = await runner.pullRepo({ params: { projectId: project.id }, body: { extraHeader, mode: 'ff-only', actorUserId: ctx.user.id } });
    result = { outcome: pulled.outcome, commits: pulled.commits, sync: pulled.sync };
  } catch (error) {
    if (error instanceof RunnerError && error.reason === 'NO_UPSTREAM') {
      // A local-only branch: refresh origin at least, nothing to pull.
      const fetched = await runner.fetchRepo({ params: { projectId: project.id }, body: { extraHeader, actorUserId: ctx.user.id } }).catch(withSyncCopy);
      result = { outcome: 'fetched', commits: 0, sync: fetched.sync };
    } else {
      await auditIn(ctx, {
        action: 'project.sync_failed',
        summary: `synchronisation de ${project.name} échouée : ${error instanceof Error ? error.message : 'erreur'}`,
        targetType: 'project',
        targetId: project.id,
        environmentId,
        metadata: { reason: error instanceof RunnerError ? (error.reason ?? null) : null },
      });
      withSyncCopy(error);
    }
  }
  await auditIn(ctx, {
    action: 'project.synced',
    summary:
      result.outcome === 'fast_forward'
        ? `${project.name} synchronisé : ${result.commits} commit${result.commits > 1 ? 's' : ''} récupéré${result.commits > 1 ? 's' : ''}`
        : `${project.name} synchronisé (déjà à jour)`,
    targetType: 'project',
    targetId: project.id,
    environmentId,
    metadata: { outcome: result.outcome, commits: result.commits, branch: result.sync.branch },
  });
  const fresh = await requireProject(ctx, project.id);
  return { ...result, project: await loadListItem(fresh.row) };
}
