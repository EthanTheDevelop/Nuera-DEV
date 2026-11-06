import 'server-only';
import type { CommitSummary } from '@nuera/shared/runner';
import type { HomeActivity, HomeGitEvent } from '@/features/home/types';
import { githubWebUrl } from '@/server/github/config';
import { getRunnerForEnvironment, isRunnerUnavailable, RunnerError } from '@/server/runner/client';
import type { RequestContext } from '@/server/tenancy/context';
import { loadRecentPullRequests, loadRecentWorktrees, loadSessionCommitShas, type LogTarget, type PullRequestRow } from './queries';

/**
 * `Tuile · Dernières modifications` (D01) / M01: commits really present in the recent projects'
 * histories (runner `repoLog`, bounded) plus the pull requests Nuera Dev opened. Authors are never
 * invented: « par Claude Code » only for a commit made from a Nuera Dev session.
 */

export const ACTIVITY_LIMIT = 6;
const COMMITS_PER_SOURCE = 4;
const LOG_TIMEOUT_MS = 4_000;

/**
 * The server down, or so slow that a bounded read timed out (`UPSTREAM` caused by a `TimeoutError`, for
 * which `isRunnerUnavailable` is false): both mean « le serveur ne répond pas ».
 */
export function runnerNotAnswering(error: unknown): boolean {
  if (isRunnerUnavailable(error)) return true;
  if (!(error instanceof RunnerError) || error.code !== 'UPSTREAM') return false;
  return (error.cause as { name?: unknown } | undefined)?.name === 'TimeoutError';
}

export interface CommitSource {
  target: LogTarget;
  commits: CommitSummary[];
}

/** Web page of the repository (`projects.html_url`, else the GitHub web base + `owner/repo`). */
export function repoWebUrl(target: Pick<LogTarget, 'htmlUrl' | 'fullName'>, webBase: string): string {
  const url = target.htmlUrl?.trim();
  if (url && /^https?:\/\//i.test(url)) return url.replace(/\/+$/, '');
  return `${webBase.replace(/\/+$/, '')}/${target.fullName}`;
}

/** « Galerie photos : pull request ouverte vers main » (D01). */
export function pullRequestMessage(pr: Pick<PullRequestRow, 'title' | 'state' | 'baseBranch'>): string {
  switch (pr.state) {
    case 'merged':
      return `${pr.title} : pull request fusionnée dans ${pr.baseBranch}`;
    case 'closed':
      return `${pr.title} : pull request fermée`;
    default:
      return `${pr.title} : pull request ouverte vers ${pr.baseBranch}`;
  }
}

/**
 * Merges the commit sources (primary clones first, so a commit shared with a session branch keeps the
 * default branch) and the pull requests, newest first, deduplicated by SHA.
 */
export function mergeActivity(input: {
  sources: readonly CommitSource[];
  pullRequests: readonly PullRequestRow[];
  claudeShas: ReadonlySet<string>;
  webBase: string;
  limit?: number;
}): HomeGitEvent[] {
  const seen = new Set<string>();
  const events: HomeGitEvent[] = [];
  const ordered = [...input.sources].sort((a, b) => Number(a.target.worktreeId !== null) - Number(b.target.worktreeId !== null));
  for (const { target, commits } of ordered) {
    const repo = repoWebUrl(target, input.webBase);
    for (const commit of commits) {
      if (seen.has(commit.sha) || Number.isNaN(Date.parse(commit.authoredAt))) continue;
      seen.add(commit.sha);
      events.push({
        id: `commit:${commit.sha}`,
        kind: 'commit',
        sha: commit.sha,
        number: null,
        message: commit.subject,
        projectId: target.projectId,
        projectName: target.projectName,
        branch: target.branch,
        byClaude: input.claudeShas.has(commit.sha),
        at: commit.authoredAt,
        href: `${repo}/commit/${commit.sha}`,
      });
    }
  }
  for (const pr of input.pullRequests) {
    events.push({
      id: `pr:${pr.id}`,
      kind: 'pull_request',
      sha: null,
      number: pr.number,
      message: pullRequestMessage(pr),
      projectId: pr.projectId,
      projectName: pr.projectName,
      branch: pr.headBranch,
      byClaude: false,
      at: pr.at,
      href: /^https?:\/\//i.test(pr.url) ? pr.url : null,
    });
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, input.limit ?? ACTIVITY_LIMIT);
}

/** « Ouvrir sur GitHub »: commits of the most recent row's branch (or the repository). */
export function activityGithubUrl(first: HomeGitEvent | undefined, targets: readonly LogTarget[], webBase: string): string | null {
  if (!first) return null;
  if (first.kind === 'pull_request' && first.href) return first.href.replace(/\/pull\/\d+$/, '/pulls');
  const target = targets.find((t) => t.projectId === first.projectId);
  if (!target) return first.href;
  const repo = repoWebUrl(target, webBase);
  return first.branch ? `${repo}/commits/${encodeURIComponent(first.branch).replace(/%2F/g, '/')}` : repo;
}

/**
 * Activity of the space: `primaries` (recent projects of the space) plus its recent session
 * worktrees, each history read on the runner of the server holding the project.
 */
export async function loadActivity(ctx: Pick<RequestContext, 'space'>, primaries: readonly LogTarget[]): Promise<HomeActivity> {
  const webBase = githubWebUrl();
  const [worktreeTargets, pullRequests, claudeShas] = await Promise.all([
    loadRecentWorktrees(ctx, 3),
    loadRecentPullRequests(ctx, 4),
    loadSessionCommitShas(ctx),
  ]);
  const targets = [...primaries, ...worktreeTargets];
  let unavailable = false;
  let incomplete = false;
  const settled = await Promise.all(
    targets.map(async (target): Promise<CommitSource | null> => {
      try {
        const { commits } = await getRunnerForEnvironment(target.environmentId).repoLog(
          { params: { projectId: target.projectId }, query: { n: COMMITS_PER_SOURCE, ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}) } },
          { timeoutMs: LOG_TIMEOUT_MS },
        );
        return { target, commits };
      } catch (error) {
        if (runnerNotAnswering(error)) unavailable = true;
        incomplete = true;
        return null;
      }
    }),
  );
  const sources = settled.filter((s): s is CommitSource => s !== null);
  const items = mergeActivity({ sources, pullRequests, claudeShas, webBase });
  const allFailed = targets.length > 0 && sources.length === 0;
  return {
    items,
    githubUrl: activityGithubUrl(items[0], targets, webBase),
    incomplete,
    error: allFailed && items.length === 0 ? (unavailable ? 'runner_unavailable' : 'failed') : null,
  };
}
