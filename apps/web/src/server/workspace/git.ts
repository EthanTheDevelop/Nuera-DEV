import 'server-only';
import { pullRequests } from '@nuera/db/schema';
import type { ChangesResponse, FileDiff, GitStatus } from '@nuera/shared/runner';
import { shortSha } from '@nuera/shared/format';
import type {
  CommitInput,
  CommitResultView,
  PullRequestInput,
  PushResultView,
  WorkspacePullRequest,
  WorktreeStatusView,
} from '@/features/workspace/lib/contract';
import type { CurrentUser } from '@/server/auth/session';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { createPullRequest, getGitAuthForRepo } from '@/server/github';
import { runner } from '@/server/runner/client';
import { audit } from '@/server/security/audit';
import { githubHtmlUrl, requireWorktreeContext } from './access';
import { readBranchStatus } from './data';

/**
 * Git side of the Workspace (D05 `Modifications` / `Actions Git`, W4, W5, S2, S3). The runner runs
 * git in the worktree; the web mints the GitHub token (contents:write, this repository only) for
 * the push and calls the GitHub API for the pull request. Commit, push and pull request are
 * audited (`git.commit`, `git.push`, `github.pull_request`).
 */

export const GIT_AUDIT_ACTIONS = {
  commit: 'git.commit',
  push: 'git.push',
  pullRequest: 'github.pull_request',
} as const;

export async function getChanges(worktreeId: string): Promise<ChangesResponse> {
  await requireWorktreeContext(worktreeId);
  return runner.worktreeChanges({ params: { worktreeId }, query: { against: 'head' } }, { timeoutMs: 20_000 });
}

export async function getDiff(worktreeId: string, path: string, against: 'head' | 'staged' = 'head'): Promise<FileDiff> {
  await requireWorktreeContext(worktreeId);
  return runner.worktreeDiff({ params: { worktreeId }, query: { path, against } }, { timeoutMs: 20_000 });
}

export async function getWorktreeStatus(worktreeId: string): Promise<WorktreeStatusView> {
  const { worktree, project } = await requireWorktreeContext(worktreeId);
  const [status, branch] = await Promise.all([
    runner.worktreeStatus({ params: { worktreeId } }, { timeoutMs: 15_000 }),
    readBranchStatus(worktreeId, worktree.baseBranch ?? project.defaultBranch),
  ]);
  return { status, branch };
}

export async function stagePaths(worktreeId: string, paths: string[]): Promise<{ status: GitStatus }> {
  await requireWorktreeContext(worktreeId);
  return runner.stagePaths({ params: { worktreeId }, body: { paths } });
}

export async function unstagePaths(worktreeId: string, paths: string[]): Promise<{ status: GitStatus }> {
  await requireWorktreeContext(worktreeId);
  return runner.unstagePaths({ params: { worktreeId }, body: { paths } });
}

/** W5 step 1: `git add -- <paths>` then `git commit` with the owner as author. */
export async function commitChanges(
  worktreeId: string,
  input: CommitInput,
  actor: Pick<CurrentUser, 'id' | 'name' | 'email'>,
): Promise<CommitResultView> {
  const { worktree, project } = await requireWorktreeContext(worktreeId);
  const body = input.body?.trim() ? input.body.trim() : undefined;
  const result = await runner.commit({
    params: { worktreeId },
    body: {
      message: input.message,
      ...(body ? { body } : {}),
      author: { name: actor.name, email: actor.email },
      paths: input.paths,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      actorUserId: actor.id,
    },
  });
  await audit({
    action: GIT_AUDIT_ACTIONS.commit,
    summary: `commit ${result.shortSha} « ${input.message} » · ${result.branch ?? worktree.branch} · ${project.name}`,
    targetType: 'project',
    targetId: project.id,
    actorUserId: actor.id,
    metadata: {
      worktreeId,
      sessionId: input.sessionId ?? null,
      sha: result.sha,
      files: result.filesCommitted,
      insertions: result.insertions,
      deletions: result.deletions,
    },
  });
  return {
    sha: result.sha,
    shortSha: result.shortSha,
    branch: result.branch,
    filesCommitted: result.filesCommitted,
    insertions: result.insertions,
    deletions: result.deletions,
  };
}

/** W5 step 2: `git push` of the worktree branch to GitHub (never the default branch). */
export async function pushBranch(
  worktreeId: string,
  input: { sessionId?: string | undefined },
  actor: Pick<CurrentUser, 'id'>,
): Promise<PushResultView> {
  const { worktree, project } = await requireWorktreeContext(worktreeId);
  if (worktree.branch === project.defaultBranch) {
    throw new AppError('CONFLICT', `${project.defaultBranch} est la branche par défaut : elle évolue par pull request, jamais par un push direct.`, {
      untouched: "Rien n'a été envoyé sur GitHub.",
    });
  }
  const { extraHeader } = await getGitAuthForRepo(project.githubFullName, 'write');
  const result = await runner.push({
    params: { worktreeId },
    body: {
      extraHeader,
      setUpstream: true,
      protectedBranches: [project.defaultBranch],
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      actorUserId: actor.id,
    },
  });
  await audit({
    action: GIT_AUDIT_ACTIONS.push,
    summary: `push de ${result.branch} vers origin/${result.remoteBranch} · ${project.name}`,
    targetType: 'project',
    targetId: project.id,
    actorUserId: actor.id,
    metadata: {
      worktreeId,
      sessionId: input.sessionId ?? null,
      headSha: result.headSha,
      upToDate: result.upToDate,
      createdRemoteBranch: result.createdRemoteBranch,
    },
  });
  return {
    branch: result.branch,
    remoteBranch: result.remoteBranch,
    headSha: result.headSha,
    upToDate: result.upToDate,
    createdRemoteBranch: result.createdRemoteBranch,
    url: `${githubHtmlUrl(project)}/tree/${result.remoteBranch.split('/').map(encodeURIComponent).join('/')}`,
  };
}

/** W5 step 3: pull request from the worktree branch (GitHub API, token limited to pull_requests:write). */
export async function openPullRequest(
  worktreeId: string,
  input: PullRequestInput,
  actor: Pick<CurrentUser, 'id'>,
): Promise<WorkspacePullRequest> {
  const { worktree, project } = await requireWorktreeContext(worktreeId);
  const base = input.base ?? worktree.baseBranch ?? project.defaultBranch;
  const body = input.body?.trim() ? input.body.trim() : undefined;
  const pr = await createPullRequest({
    fullName: project.githubFullName,
    title: input.title,
    head: worktree.branch,
    base,
    ...(body ? { body } : {}),
    ...(input.draft ? { draft: true } : {}),
  });
  await db
    .insert(pullRequests)
    .values({
      projectId: project.id,
      sessionId: input.sessionId ?? null,
      number: pr.number,
      title: pr.title,
      headBranch: pr.headRef,
      baseBranch: pr.baseRef,
      url: pr.url,
      state: pr.state,
      draft: pr.draft,
      lastSyncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [pullRequests.projectId, pullRequests.number],
      set: { title: pr.title, url: pr.url, state: pr.state, draft: pr.draft, lastSyncedAt: new Date() },
    });
  await audit({
    action: GIT_AUDIT_ACTIONS.pullRequest,
    summary: `pull request #${pr.number} ouverte : « ${pr.title} » · ${pr.headRef} → ${pr.baseRef} · ${project.name}`,
    targetType: 'project',
    targetId: project.id,
    actorUserId: actor.id,
    metadata: { worktreeId, sessionId: input.sessionId ?? null, number: pr.number, url: pr.url, draft: pr.draft, headSha: shortSha(pr.headSha) },
  });
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    draft: pr.draft,
    baseBranch: pr.baseRef,
    headBranch: pr.headRef,
  };
}
