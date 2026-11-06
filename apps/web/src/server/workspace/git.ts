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
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { createPullRequest, getGitAuthForProject, listProtectedBranches } from '@/server/github';
import { getGitIdentity } from '@/server/sessions';
import type { RequestContext } from '@/server/tenancy/context';
import { auditIn } from '@/server/tenancy/scope';
import { assertSessionOfWorktree, githubHtmlUrl, requireWorktreeContext } from './access';
import { readBranchStatus } from './data';

/**
 * Git side of the Workspace (D05 `Modifications` / `Actions Git`, W4, W5, S2, S3). The runner of
 * the server holding the project runs git in the worktree; the web mints the GitHub token of the
 * project's GitHub source (contents:write, this repository only) for the push and calls the GitHub
 * API through that source for the pull request. Commits are authored with the account's Git
 * identity (Paramètres, else the account). Commit, push and pull request are audited in the
 * space (`git.commit`, `git.push`, `github.pull_request`).
 */

export const GIT_AUDIT_ACTIONS = {
  commit: 'git.commit',
  push: 'git.push',
  pullRequest: 'github.pull_request',
} as const;

type WorkspaceCtx = Pick<RequestContext, 'user' | 'space' | 'environment'>;

export async function getChanges(ctx: Pick<RequestContext, 'space'>, worktreeId: string): Promise<ChangesResponse> {
  const { scope } = await requireWorktreeContext(ctx, worktreeId);
  return scope.runner.worktreeChanges({ params: { worktreeId: scope.worktreeId }, query: { against: 'head' } }, { timeoutMs: 20_000 });
}

export async function getDiff(ctx: Pick<RequestContext, 'space'>, worktreeId: string, path: string, against: 'head' | 'staged' = 'head'): Promise<FileDiff> {
  const { scope } = await requireWorktreeContext(ctx, worktreeId);
  return scope.runner.worktreeDiff({ params: { worktreeId: scope.worktreeId }, query: { path, against } }, { timeoutMs: 20_000 });
}

export async function getWorktreeStatus(ctx: Pick<RequestContext, 'space'>, worktreeId: string): Promise<WorktreeStatusView> {
  const { scope, worktree, project } = await requireWorktreeContext(ctx, worktreeId);
  const [status, branch] = await Promise.all([
    scope.runner.worktreeStatus({ params: { worktreeId: scope.worktreeId } }, { timeoutMs: 15_000 }),
    readBranchStatus(scope.runner, scope.worktreeId, worktree.baseBranch ?? project.defaultBranch),
  ]);
  return { status, branch };
}

export async function stagePaths(ctx: Pick<RequestContext, 'space'>, worktreeId: string, paths: string[]): Promise<{ status: GitStatus }> {
  const { scope } = await requireWorktreeContext(ctx, worktreeId);
  return scope.runner.stagePaths({ params: { worktreeId: scope.worktreeId }, body: { paths } });
}

export async function unstagePaths(ctx: Pick<RequestContext, 'space'>, worktreeId: string, paths: string[]): Promise<{ status: GitStatus }> {
  const { scope } = await requireWorktreeContext(ctx, worktreeId);
  return scope.runner.unstagePaths({ params: { worktreeId: scope.worktreeId }, body: { paths } });
}

/** W5 step 1: `git add -- <paths>` then `git commit` with the account's Git identity as author. */
export async function commitChanges(ctx: WorkspaceCtx, worktreeId: string, input: CommitInput): Promise<CommitResultView> {
  const { scope, worktree, project } = await requireWorktreeContext(ctx, worktreeId);
  await assertSessionOfWorktree(scope.worktreeId, input.sessionId);
  const body = input.body?.trim() ? input.body.trim() : undefined;
  const author = (await getGitIdentity(ctx.user)) ?? { name: ctx.user.name, email: ctx.user.email };
  const result = await scope.runner.commit({
    params: { worktreeId: scope.worktreeId },
    body: {
      message: input.message,
      ...(body ? { body } : {}),
      author,
      paths: input.paths,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      actorUserId: ctx.user.id,
    },
  });
  await auditIn(ctx, {
    action: GIT_AUDIT_ACTIONS.commit,
    summary: `commit ${result.shortSha} « ${input.message} » · ${result.branch ?? worktree.branch} · ${project.name}`,
    targetType: 'project',
    targetId: project.id,
    environmentId: scope.environmentId,
    metadata: {
      worktreeId: scope.worktreeId,
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
export async function pushBranch(ctx: WorkspaceCtx, worktreeId: string, input: { sessionId?: string | undefined }): Promise<PushResultView> {
  const { scope, worktree, project } = await requireWorktreeContext(ctx, worktreeId);
  await assertSessionOfWorktree(scope.worktreeId, input.sessionId);
  if (worktree.branch === project.defaultBranch) {
    throw new AppError('CONFLICT', `${project.defaultBranch} est la branche par défaut : elle évolue par pull request, jamais par un push direct.`, {
      untouched: "Rien n'a été envoyé sur GitHub.",
    });
  }
  const protectedBranches = await listProtectedBranches(project, project.defaultBranch, { maxAgeMs: 0 });
  if (worktree.branch && protectedBranches.includes(worktree.branch)) {
    throw new AppError('CONFLICT', `${worktree.branch} est protégée sur GitHub : elle évolue par pull request, jamais par un push direct.`, {
      untouched: "Rien n'a été envoyé sur GitHub.",
    });
  }
  const { extraHeader } = await getGitAuthForProject(project, 'write');
  const result = await scope.runner.push({
    params: { worktreeId: scope.worktreeId },
    body: {
      extraHeader,
      setUpstream: true,
      protectedBranches,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      actorUserId: ctx.user.id,
    },
  });
  await auditIn(ctx, {
    action: GIT_AUDIT_ACTIONS.push,
    summary: `push de ${result.branch} vers origin/${result.remoteBranch} · ${project.name}`,
    targetType: 'project',
    targetId: project.id,
    environmentId: scope.environmentId,
    metadata: {
      worktreeId: scope.worktreeId,
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

/** W5 step 3: pull request from the worktree branch (GitHub source of the project, pull_requests:write). */
export async function openPullRequest(ctx: WorkspaceCtx, worktreeId: string, input: PullRequestInput): Promise<WorkspacePullRequest> {
  const { scope, worktree, project } = await requireWorktreeContext(ctx, worktreeId);
  await assertSessionOfWorktree(scope.worktreeId, input.sessionId);
  const base = input.base ?? worktree.baseBranch ?? project.defaultBranch;
  const body = input.body?.trim() ? input.body.trim() : undefined;
  const pr = await createPullRequest(project, {
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
  await auditIn(ctx, {
    action: GIT_AUDIT_ACTIONS.pullRequest,
    summary: `pull request #${pr.number} ouverte : « ${pr.title} » · ${pr.headRef} → ${pr.baseRef} · ${project.name}`,
    targetType: 'project',
    targetId: project.id,
    environmentId: scope.environmentId,
    metadata: {
      worktreeId: scope.worktreeId,
      sessionId: input.sessionId ?? null,
      number: pr.number,
      url: pr.url,
      draft: pr.draft,
      headSha: shortSha(pr.headSha),
    },
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
