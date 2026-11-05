import 'server-only';
import { AppError } from '@/server/errors';
import { createOctokit, type Octokit } from './client';
import { fallbackToken, parseFullName } from './config';
import { resolveInstallationForRepo } from './installations';
import { getStoredGithubApp } from './store';
import { mintInstallationToken } from './tokens';
import type { GithubMode, GithubTokenPermissions } from './types';

/**
 * Credentials for one repository and one operation:
 *  - GitHub App (normal mode): installation token restricted to that repository and to the
 *    permissions of the operation (research §2.5);
 *  - GITHUB_FALLBACK_TOKEN (documented fallback, env only, never configurable in the UI).
 */

/** Read access used by default for API calls on a repository. */
export const REPO_READ_PERMISSIONS = {
  metadata: 'read',
  contents: 'read',
} as const satisfies GithubTokenPermissions;

export interface RepoCredential {
  mode: Exclude<GithubMode, 'none'>;
  token: string;
  /** ISO date until which the credential can be reused. */
  expiresAt: string;
  installationId: number | null;
  owner: string;
  repo: string;
}

/** Which credential source is configured (no network call). */
export async function getGithubMode(): Promise<GithubMode> {
  if (await getStoredGithubApp()) return 'app';
  return fallbackToken() ? 'fallback_token' : 'none';
}

export async function getRepoCredential(fullName: string, permissions: GithubTokenPermissions): Promise<RepoCredential> {
  const { owner, repo } = parseFullName(fullName);
  const mode = await getGithubMode();
  if (mode === 'app') {
    const resolved = await resolveInstallationForRepo(fullName);
    const minted = await mintInstallationToken({
      installationId: resolved.installation.id,
      repositoryNames: [resolved.repo],
      permissions,
    });
    return {
      mode,
      token: minted.token,
      expiresAt: minted.expiresAt,
      installationId: resolved.installation.id,
      owner: resolved.owner,
      repo: resolved.repo,
    };
  }
  if (mode === 'fallback_token') {
    const token = fallbackToken()!;
    // A PAT has no per-call expiry: the runner may reuse the header for one hour at most.
    return { mode, token, expiresAt: new Date(Date.now() + 3600_000).toISOString(), installationId: null, owner, repo };
  }
  throw new AppError('CONFLICT', "GitHub n'est pas connecté : créez l'application GitHub depuis Intégrations.");
}

/** Octokit authenticated for `owner/repo` with a down-scoped token (default: metadata + contents read). */
export async function getOctokitForRepo(
  fullName: string,
  permissions: GithubTokenPermissions = REPO_READ_PERMISSIONS,
): Promise<Octokit> {
  const credential = await getRepoCredential(fullName, permissions);
  return createOctokit(credential.token);
}

/**
 * Value for `http.https://github.com/.extraheader`, injected by the runner into ONE git process
 * through GIT_CONFIG_COUNT/KEY/VALUE (research §2.7) — the same header `actions/checkout` builds.
 * `read` = contents:read (clone, fetch, pull, ls-remote), `write` = contents:write (push).
 */
export async function getGitAuthForRepo(
  fullName: string,
  access: 'read' | 'write',
): Promise<{ extraHeader: string; expiresAt: string }> {
  const credential = await getRepoCredential(fullName, {
    metadata: 'read',
    contents: access === 'write' ? 'write' : 'read',
  });
  const basic = Buffer.from(`x-access-token:${credential.token}`, 'utf8').toString('base64');
  return { extraHeader: `AUTHORIZATION: basic ${basic}`, expiresAt: credential.expiresAt };
}
