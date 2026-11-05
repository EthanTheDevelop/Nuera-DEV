import 'server-only';
import { z } from 'zod';
import { AppError } from '@/server/errors';
import { getOctokitForRepo } from './access';
import { githubErrorMessage, githubErrorStatus, toGithubAppError, type Octokit } from './client';
import { parseFullName } from './config';
import type { ChecksState, CreatePullRequestInput, PullRequestDetail, PullRequestInfo, ReviewsState } from './types';

/**
 * Pull requests (W5 « Préparer le commit », research §2.8–2.9). Each call mints a token restricted
 * to the repository and to the permissions of the operation.
 */

const branchName = z
  .string()
  .trim()
  .min(1, 'branche requise')
  .max(255)
  .refine((value) => !/[\s~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|^-/.test(value), 'nom de branche invalide');

export const createPullRequestInputSchema = z.object({
  fullName: z.string().trim().min(3),
  title: z.string().trim().min(1, 'titre requis').max(256, '256 caractères au maximum'),
  head: branchName,
  base: branchName,
  body: z.string().max(65_000).optional(),
  draft: z.boolean().optional(),
  maintainerCanModify: z.boolean().optional(),
});

const pullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
  requested_reviewers: z.array(z.object({ login: z.string() })).optional(),
});

function toInfo(pull: z.infer<typeof pullSchema>): PullRequestInfo {
  const merged = Boolean(pull.merged || pull.merged_at);
  return {
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    state: merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'open',
    draft: Boolean(pull.draft),
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    createdAt: pull.created_at ?? null,
  };
}

export async function createPullRequest(input: CreatePullRequestInput): Promise<PullRequestInfo> {
  const parsed = createPullRequestInputSchema.parse(input);
  const { owner, repo } = parseFullName(parsed.fullName);
  if (parsed.head === parsed.base) {
    throw new AppError('VALIDATION', 'La branche de la pull request doit différer de la branche cible.');
  }
  const octokit = await getOctokitForRepo(parsed.fullName, { metadata: 'read', pull_requests: 'write' });
  try {
    const { data } = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
      owner,
      repo,
      title: parsed.title,
      head: parsed.head,
      base: parsed.base,
      ...(parsed.body !== undefined ? { body: parsed.body } : {}),
      draft: parsed.draft ?? false,
      maintainer_can_modify: parsed.maintainerCanModify ?? true,
    });
    return toInfo(pullSchema.parse(data));
  } catch (error) {
    if (githubErrorStatus(error) === 422) {
      const raw = githubErrorMessage(error) ?? '';
      const full = JSON.stringify((error as { response?: { data?: unknown } }).response?.data ?? '');
      if (/already exists/i.test(full)) {
        throw new AppError('CONFLICT', 'Une pull request est déjà ouverte pour cette branche.', {
          raw: raw || full,
          untouched: "Aucune nouvelle pull request n'a été créée.",
        });
      }
      if (/no commits between/i.test(full)) {
        throw new AppError('VALIDATION', `Aucun commit entre ${parsed.base} et ${parsed.head} : poussez d'abord la branche.`, {
          raw: raw || full,
        });
      }
    }
    throw toGithubAppError(error, 'la création de la pull request');
  }
}

/** CI badge from check runs + combined status (research §2.9). */
export function deriveChecksState(
  runs: Array<{ status: string; conclusion: string | null }>,
  combined: { state: string; total: number } | null,
): ChecksState {
  const failing = new Set(['failure', 'timed_out', 'action_required', 'cancelled']);
  if (runs.some((run) => run.conclusion && failing.has(run.conclusion)) || combined?.state === 'failure' || combined?.state === 'error') {
    return 'failure';
  }
  if (runs.some((run) => run.status !== 'completed') || (combined?.state === 'pending' && (combined.total ?? 0) > 0)) {
    return 'pending';
  }
  if (runs.length > 0 || (combined && combined.total > 0)) return 'success';
  return 'none';
}

/** Review badge: latest review per reviewer, COMMENTED ignored (research §2.9). */
export function deriveReviewsState(
  reviews: Array<{ user: string; state: string; submittedAt: string | null }>,
  requestedReviewers: string[],
): { state: ReviewsState; approvals: number; changesRequested: number } {
  const latest = new Map<string, string>();
  for (const review of [...reviews].sort((a, b) => Date.parse(a.submittedAt ?? '0') - Date.parse(b.submittedAt ?? '0'))) {
    if (review.state === 'COMMENTED' || review.state === 'PENDING') continue;
    latest.set(review.user, review.state);
  }
  const states = [...latest.values()];
  const approvals = states.filter((value) => value === 'APPROVED').length;
  const changesRequested = states.filter((value) => value === 'CHANGES_REQUESTED').length;
  const state: ReviewsState =
    changesRequested > 0 ? 'changes_requested' : approvals > 0 ? 'approved' : requestedReviewers.length ? 'pending' : 'none';
  return { state, approvals, changesRequested };
}

async function readChecks(octokit: Octokit, owner: string, repo: string, ref: string) {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
      owner,
      repo,
      ref,
      filter: 'latest',
      per_page: 100,
    });
    return data.check_runs.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion ?? null,
      url: run.html_url ?? run.details_url ?? null,
    }));
  } catch (error) {
    if ([403, 404].includes(githubErrorStatus(error) ?? 0)) return null; // permission not granted (older installation)
    throw error;
  }
}

async function readStatuses(octokit: Octokit, owner: string, repo: string, ref: string) {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/status', { owner, repo, ref, per_page: 100 });
    return {
      state: data.state,
      total: data.total_count,
      statuses: data.statuses.map((status) => ({
        context: status.context,
        state: status.state,
        description: status.description ?? null,
        url: status.target_url ?? null,
      })),
    };
  } catch (error) {
    if ([403, 404].includes(githubErrorStatus(error) ?? 0)) return null;
    throw error;
  }
}

async function readReviews(octokit: Octokit, owner: string, repo: string, pullNumber: number) {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    return data.map((review) => ({
      user: review.user?.login ?? '',
      state: review.state,
      submittedAt: review.submitted_at ?? null,
    }));
  } catch (error) {
    if ([403, 404].includes(githubErrorStatus(error) ?? 0)) return null;
    throw error;
  }
}

/** Pull request with its combined CI state (check runs + commit statuses) and review state. */
export async function getPullRequest(fullName: string, pullNumber: number): Promise<PullRequestDetail> {
  const { owner, repo } = parseFullName(fullName);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) throw new AppError('VALIDATION', 'Numéro de pull request invalide.');
  const octokit = await getOctokitForRepo(fullName, {
    metadata: 'read',
    contents: 'read',
    pull_requests: 'read',
    checks: 'read',
    statuses: 'read',
  });
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: pullNumber,
    });
    const pull = pullSchema.parse(data);
    const [runs, combined, reviews] = await Promise.all([
      readChecks(octokit, owner, repo, pull.head.sha),
      readStatuses(octokit, owner, repo, pull.head.sha),
      readReviews(octokit, owner, repo, pull.number),
    ]);
    const requested = (pull.requested_reviewers ?? []).map((reviewer) => reviewer.login);
    const reviewState = reviews ? deriveReviewsState(reviews, requested) : { state: 'unavailable' as const, approvals: 0, changesRequested: 0 };
    const checksState: ChecksState =
      runs === null && combined === null
        ? 'unavailable'
        : deriveChecksState(runs ?? [], combined ? { state: combined.state, total: combined.total } : null);
    const info = toInfo(pull);
    return {
      ...info,
      merged: info.state === 'merged',
      mergedAt: pull.merged_at ?? null,
      mergeable: pull.mergeable ?? null,
      mergeableState: pull.mergeable_state ?? null,
      checks: {
        state: checksState,
        total: (runs?.length ?? 0) + (combined?.total ?? 0),
        runs: runs ?? [],
        statuses: combined?.statuses ?? [],
      },
      reviews: { ...reviewState, requestedReviewers: requested },
    };
  } catch (error) {
    throw toGithubAppError(error, `la lecture de la pull request #${pullNumber}`);
  }
}
