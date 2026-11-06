import 'server-only';
import { projects } from '@nuera/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { createOctokit, type Octokit } from './client';
import { fallbackTokenFor, parseFullName } from './config';
import { notAccessibleInSpace, resolveInstallationInSource, resolveRepoInstallations, type ResolvedInstallation } from './installations';
import { countGithubSources, listGithubSources } from './store';
import { getAppCredentials, mintInstallationToken } from './tokens';
import type { GithubMode, GithubProjectRef, GithubRepoRef, GithubTokenPermissions } from './types';

/**
 * Credentials for one repository and one operation, always within ONE space (MULTICOMPTE §7):
 *  - GitHub App of a source of the space (normal mode): installation token restricted to that
 *    repository and to the permissions of the operation (research §2.5);
 *  - GITHUB_FALLBACK_TOKEN (documented fallback, env only, never configurable in the UI), only for
 *    the space of the default server, and only while that space has no GitHub source.
 *
 * Before a project exists (A1, D03): `getOctokitForRepo({ spaceId, sourceId?, fullName })`.
 * For a project: `getOctokitForProject(project)` / `getGitAuthForProject(project, access)` use the
 * project's own source only (`projects.github_source_id`, bound lazily when still null).
 */

/** Read access used by default for API calls on a repository. */
export const REPO_READ_PERMISSIONS = {
  metadata: 'read',
  contents: 'read',
} as const satisfies GithubTokenPermissions;

export const GITHUB_NOT_CONNECTED = "GitHub n'est pas connecté : créez l'application GitHub depuis Intégrations.";

export interface RepoCredential {
  mode: Exclude<GithubMode, 'none'>;
  token: string;
  /** ISO date until which the credential can be reused. */
  expiresAt: string;
  installationId: number | null;
  /** Source that delivered the token (null: GITHUB_FALLBACK_TOKEN). */
  sourceId: string | null;
  sourceLabel: string | null;
  owner: string;
  repo: string;
}

/** Which credential the space uses (no network call). */
export async function getGithubMode(spaceId: string): Promise<GithubMode> {
  if ((await countGithubSources(spaceId)) > 0) return 'app';
  return (await fallbackTokenFor(spaceId)) ? 'fallback_token' : 'none';
}

async function mint(candidate: ResolvedInstallation, permissions: GithubTokenPermissions): Promise<RepoCredential> {
  const minted = await mintInstallationToken({
    installationId: candidate.installation.id,
    repositoryNames: [candidate.repo],
    permissions,
    credentials: getAppCredentials(candidate.source),
  });
  return {
    mode: 'app',
    token: minted.token,
    expiresAt: minted.expiresAt,
    installationId: candidate.installation.id,
    sourceId: candidate.source.id,
    sourceLabel: candidate.source.label,
    owner: candidate.owner,
    repo: candidate.repo,
  };
}

const refused = (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN';

export async function getRepoCredential(ref: GithubRepoRef, permissions: GithubTokenPermissions): Promise<RepoCredential> {
  const { owner, repo } = parseFullName(ref.fullName);
  const fullName = `${owner}/${repo}`;
  if (!ref.sourceId && (await countGithubSources(ref.spaceId)) === 0) {
    const token = await fallbackTokenFor(ref.spaceId);
    if (!token) throw new AppError('CONFLICT', GITHUB_NOT_CONNECTED);
    // A PAT has no per-call expiry: the runner may reuse the header for one hour at most.
    return { mode: 'fallback_token', token, expiresAt: new Date(Date.now() + 3600_000).toISOString(), installationId: null, sourceId: null, sourceLabel: null, owner, repo };
  }
  const candidates = await resolveRepoInstallations(ref, fullName);
  let firstError: unknown = null;
  for (const candidate of candidates) {
    try {
      return await mint(candidate, permissions);
    } catch (error) {
      if (!refused(error)) throw error;
      firstError ??= error;
    }
  }
  if (!ref.sourceId) {
    // The recorded installations of the owner do not cover this repository: ask the other sources.
    const tried = new Set(candidates.map((candidate) => candidate.source.id));
    const { sources } = await listGithubSources(ref.spaceId);
    for (const source of sources.filter((item) => !tried.has(item.id))) {
      try {
        return await mint(await resolveInstallationInSource(source, fullName), permissions);
      } catch (error) {
        if (!refused(error)) throw error;
      }
    }
    if (sources.length > 1) throw notAccessibleInSpace(fullName);
  }
  throw firstError ?? notAccessibleInSpace(fullName);
}

/** Octokit authenticated for `owner/repo` of the space, with a down-scoped token (default: metadata + contents read). */
export async function getOctokitForRepo(ref: GithubRepoRef, permissions: GithubTokenPermissions = REPO_READ_PERMISSIONS): Promise<Octokit> {
  const credential = await getRepoCredential(ref, permissions);
  return createOctokit(credential.token);
}

function toGitAuth(credential: RepoCredential): { extraHeader: string; expiresAt: string; sourceId: string | null } {
  const basic = Buffer.from(`x-access-token:${credential.token}`, 'utf8').toString('base64');
  return { extraHeader: `AUTHORIZATION: basic ${basic}`, expiresAt: credential.expiresAt, sourceId: credential.sourceId };
}

const gitPermissions = (access: 'read' | 'write'): GithubTokenPermissions => ({
  metadata: 'read',
  contents: access === 'write' ? 'write' : 'read',
});

/**
 * Value for `http.https://github.com/.extraheader`, injected by the runner into ONE git process
 * through GIT_CONFIG_COUNT/KEY/VALUE (research §2.7) — the same header `actions/checkout` builds.
 * `read` = contents:read (clone, fetch, pull, ls-remote), `write` = contents:write (push).
 */
export async function getGitAuthForRepo(
  ref: GithubRepoRef,
  access: 'read' | 'write',
): Promise<{ extraHeader: string; expiresAt: string; sourceId: string | null }> {
  return toGitAuth(await getRepoCredential(ref, gitPermissions(access)));
}

/**
 * Credential of a project: from ITS source only. A project without source yet (created before
 * several sources existed) is resolved in its space, then bound (`github_source_id`,
 * `github_installation_id`) so that later calls use that source.
 */
export async function getProjectCredential(project: GithubProjectRef, permissions: GithubTokenPermissions): Promise<RepoCredential> {
  if (project.githubSourceId) {
    return getRepoCredential({ spaceId: project.spaceId, sourceId: project.githubSourceId, fullName: project.githubFullName }, permissions);
  }
  const credential = await getRepoCredential({ spaceId: project.spaceId, fullName: project.githubFullName }, permissions);
  if (credential.sourceId) {
    await db
      .update(projects)
      .set({ githubSourceId: credential.sourceId, githubInstallationId: credential.installationId })
      .where(and(eq(projects.id, project.id), eq(projects.spaceId, project.spaceId), isNull(projects.githubSourceId)))
      .catch((error: unknown) => console.warn('[github] liaison de la source du projet impossible', error instanceof Error ? error.message : error));
  }
  return credential;
}

export async function getOctokitForProject(project: GithubProjectRef, permissions: GithubTokenPermissions = REPO_READ_PERMISSIONS): Promise<Octokit> {
  return createOctokit((await getProjectCredential(project, permissions)).token);
}

export async function getGitAuthForProject(
  project: GithubProjectRef,
  access: 'read' | 'write',
): Promise<{ extraHeader: string; expiresAt: string; sourceId: string | null }> {
  return toGitAuth(await getProjectCredential(project, gitPermissions(access)));
}

export interface RepoSourceBinding {
  mode: Exclude<GithubMode, 'none'>;
  /** Source to record in `projects.github_source_id` (null: GITHUB_FALLBACK_TOKEN). */
  sourceId: string | null;
  sourceLabel: string | null;
  /** To record in `projects.github_installation_id`. */
  installationId: number | null;
}

/**
 * Source to bind at project creation: the chosen one (`sourceId`, checked in the space) or the
 * first source of the space that reaches the repository. Proves the access with a metadata token.
 */
export async function resolveSourceForRepo(ref: GithubRepoRef): Promise<RepoSourceBinding> {
  const credential = await getRepoCredential(ref, { metadata: 'read' });
  return { mode: credential.mode, sourceId: credential.sourceId, sourceLabel: credential.sourceLabel, installationId: credential.installationId };
}
