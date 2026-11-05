import 'server-only';

/**
 * GitHub integration (GitHub App through the manifest flow, research §2) — public API.
 *
 *   getGitAuthForRepo('nuera-studio/nuera-os', 'write')   → value for http.https://github.com/.extraheader
 *   getOctokitForRepo('nuera-studio/nuera-os')           → Octokit with a repo-scoped, read-only token
 *   listAccessibleRepos()                                → A1 repo picker data, grouped by account
 *   createPullRequest({ fullName, title, head, base })   → W5
 *   getPullRequest(fullName, 57)                         → PR + combined checks + reviews
 *   getGithubStatus() / checkGithub()                    → D07 GitHub tile (stored / live)
 *
 * Tokens are installation tokens down-scoped per operation and per repository, kept in memory only.
 * The fallback PAT (GITHUB_FALLBACK_TOKEN) is read from the environment and never offered in the UI.
 */

export { getGitAuthForRepo, getOctokitForRepo, getRepoCredential, getGithubMode, REPO_READ_PERMISSIONS } from './access';
export { listAccessibleRepos, getRepo, listBranches } from './repos';
export { createPullRequest, createPullRequestInputSchema, getPullRequest, deriveChecksState, deriveReviewsState } from './pulls';
export { getGithubStatus, checkGithub, disconnectGithub, summarizePermissions, GITHUB_IMPACT } from './status';
export {
  buildAppManifest,
  startManifestFlow,
  startManifestInputSchema,
  renderManifestFormPage,
  completeManifestConversion,
  handleInstallationSetup,
  createGithubState,
  verifyGithubState,
  stateCookie,
  readCookie,
  GITHUB_STATE_COOKIE,
  type GithubStatePayload,
} from './manifest';
export { syncInstallations, manageAccessUrl, installUrl, resolveInstallationForRepo } from './installations';
export { mintInstallationToken, clearGithubTokenCache } from './tokens';
export { GITHUB_API_VERSION, GITHUB_REQUIRED_PERMISSIONS, githubApiUrl, githubWebUrl, parseFullName } from './config';
export type { Octokit } from './client';
export type {
  AccessibleRepo,
  AccessibleReposAccount,
  AccessibleReposResult,
  CreatePullRequestInput,
  GithubBranch,
  GithubMode,
  GithubPermissionsSummary,
  GithubRepoInfo,
  GithubStatus,
  GithubTokenPermissions,
  PullRequestDetail,
  PullRequestInfo,
} from './types';
