import 'server-only';

/**
 * GitHub integration (GitHub Apps through the manifest flow, research §2) — public API. A space has
 * up to 10 GitHub sources (one app each, MULTICOMPTE §7); every call names its space, and a source
 * of another space answers exactly like an unknown one.
 *
 * Before a project exists (A1 picker, D03 creation):
 *   listAccessibleRepos({ spaceId })                               → repositories of every source, de-duplicated
 *   resolveSourceForRepo({ spaceId, fullName, sourceId? })         → { sourceId, installationId } to bind on the project
 *   getRepo({ spaceId, sourceId?, fullName }) · listBranches(…) · listProtectedBranches({ …, defaultBranch })
 *   getOctokitForRepo({ spaceId, sourceId?, fullName }) · getGitAuthForRepo({ spaceId, sourceId?, fullName }, 'read')
 * For a project (its own source only; bound lazily when still null):
 *   getGitAuthForProject(project, 'write') · getOctokitForProject(project)
 *   createPullRequest(project, { title, head, base }) · getPullRequest(project, 57)
 * D07 (Intégrations):
 *   getGithubOverview(spaceId) · checkGithub({ spaceId }) · checkGithubSource({ spaceId, sourceId })
 *   disconnectGithubSource({ spaceId, sourceId, actorUserId })
 *
 * Tokens are installation tokens down-scoped per operation and per repository, kept in memory only
 * (cache keyed by app). GITHUB_FALLBACK_TOKEN is read from the environment, reserved to the space of
 * the default server and never offered in the UI nor to an MCP server.
 */

export {
  getGitAuthForProject,
  getGitAuthForRepo,
  getGithubMode,
  getOctokitForProject,
  getOctokitForRepo,
  getProjectCredential,
  getRepoCredential,
  resolveSourceForRepo,
  GITHUB_NOT_CONNECTED,
  REPO_READ_PERMISSIONS,
  type RepoCredential,
  type RepoSourceBinding,
} from './access';
export { listAccessibleRepos, getRepo, listBranches, listProtectedBranches, type ProtectedBranchesOptions, type RepoTarget } from './repos';
export { createPullRequest, createPullRequestInputSchema, getPullRequest, deriveChecksState, deriveReviewsState } from './pulls';
export {
  aggregateReason,
  checkGithub,
  checkGithubSource,
  checkGithubSources,
  disconnectGithub,
  disconnectGithubSource,
  getGithubOverview,
  getGithubSourceStatus,
  getGithubSourceView,
  getGithubStatus,
  githubTarget,
  installRouteOf,
  renameGithubSource,
  summarizePermissions,
  GITHUB_IMPACT,
  INSTALL_ROUTE,
  type CheckGithubOptions,
  type GithubChecksResult,
} from './status';
export {
  appNameForHost,
  buildAppManifest,
  startManifestFlow,
  startManifestInputSchema,
  renderManifestFormPage,
  completeManifestConversion,
  handleInstallationSetup,
  createGithubState,
  verifyGithubState,
  stateCookie,
  stateCookieName,
  readCookie,
  readStateCookie,
  GITHUB_STATE_COOKIE,
  SOURCE_LIMIT_MESSAGE,
  type GithubStatePayload,
} from './manifest';
export {
  findSourceForInstallation,
  installUrl,
  manageAccessUrl,
  resolveInstallationInSource,
  resolveRepoInstallations,
  syncInstallations,
} from './installations';
export {
  countGithubSources,
  findGithubSource,
  getGithubSource,
  listGithubSources,
  GITHUB_SOURCE_NOT_FOUND,
  type GithubSourceScope,
  type StoredGithubSource,
} from './store';
export { mintInstallationToken, clearGithubTokenCache } from './tokens';
export {
  GITHUB_API_VERSION,
  GITHUB_REQUIRED_PERMISSIONS,
  MAX_GITHUB_SOURCES_PER_SPACE,
  githubApiUrl,
  githubWebUrl,
  parseFullName,
} from './config';
export type { Octokit } from './client';
export type {
  AccessibleRepo,
  AccessibleReposAccount,
  AccessibleReposResult,
  AccessibleReposSource,
  CreatePullRequestInput,
  GithubBranch,
  GithubMode,
  GithubOverview,
  GithubPermissionsSummary,
  GithubProjectRef,
  GithubRepoInfo,
  GithubRepoRef,
  GithubSourceStatus,
  GithubStatus,
  GithubTokenPermissions,
  PullRequestDetail,
  PullRequestInfo,
} from './types';
