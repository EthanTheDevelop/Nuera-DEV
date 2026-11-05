import 'server-only';
import type { PullResult, SyncStatus } from '@nuera/shared/runner';
import { getGitAuthForRepo } from '@/server/github';
import { RunnerError, runner } from '@/server/runner/client';
import { audit } from '@/server/security/audit';
import { withSyncCopy } from './errors';
import { loadListItem, requireProjectRow, requireReadyProject } from './queries';
import type { ProjectListItem } from './types';

type Actor = { id: string };

export interface SyncProjectResult {
  /** `fast_forward` (N commits brought in), `up_to_date`, or `fetched` when the branch has no upstream. */
  outcome: PullResult['outcome'] | 'fetched';
  commits: number;
  sync: SyncStatus;
  project: ProjectListItem;
}

/**
 * « Synchroniser » (D02 row menu, D04 header, M04 refresh): `git fetch` then a fast-forward-only
 * pull of the primary clone, both with a READ token of that repository. Never creates a commit:
 * a diverged branch, a conflict or local changes stop it with the T4 copy (what failed, what was
 * not touched) and the runner reason (PULL_DIVERGED, PULL_CONFLICT, PULL_DIRTY, GIT_CONFIG_UNSAFE…).
 */
export async function syncProject(projectId: string, actor: Actor): Promise<SyncProjectResult> {
  const project = await requireReadyProject(projectId);
  const { extraHeader } = await getGitAuthForRepo(project.githubFullName, 'read');
  let result: { outcome: SyncProjectResult['outcome']; commits: number; sync: SyncStatus };
  try {
    const pulled = await runner.pullRepo({ params: { projectId }, body: { extraHeader, mode: 'ff-only', actorUserId: actor.id } });
    result = { outcome: pulled.outcome, commits: pulled.commits, sync: pulled.sync };
  } catch (error) {
    if (error instanceof RunnerError && error.reason === 'NO_UPSTREAM') {
      // A local-only branch: refresh origin at least, nothing to pull.
      const fetched = await runner.fetchRepo({ params: { projectId }, body: { extraHeader, actorUserId: actor.id } }).catch(withSyncCopy);
      result = { outcome: 'fetched', commits: 0, sync: fetched.sync };
    } else {
      await audit({
        action: 'project.sync_failed',
        summary: `synchronisation de ${project.name} échouée : ${error instanceof Error ? error.message : 'erreur'}`,
        targetType: 'project',
        targetId: project.id,
        metadata: { reason: error instanceof RunnerError ? (error.reason ?? null) : null },
        actorUserId: actor.id,
      });
      withSyncCopy(error);
    }
  }
  await audit({
    action: 'project.synced',
    summary:
      result.outcome === 'fast_forward'
        ? `${project.name} synchronisé : ${result.commits} commit${result.commits > 1 ? 's' : ''} récupéré${result.commits > 1 ? 's' : ''}`
        : `${project.name} synchronisé (déjà à jour)`,
    targetType: 'project',
    targetId: project.id,
    metadata: { outcome: result.outcome, commits: result.commits, branch: result.sync.branch },
    actorUserId: actor.id,
  });
  const row = await requireProjectRow(projectId);
  return { ...result, project: await loadListItem(row) };
}
