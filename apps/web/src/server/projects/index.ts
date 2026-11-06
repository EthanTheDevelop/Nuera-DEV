import 'server-only';

/**
 * Projets domain (D02/M02 list, D03 + A1–A4 / M03 add flow, D04/M04 project page) — public API.
 * Every function takes the request context first (docs/MULTICOMPTE.md §5): lists and counters are
 * those of the space, a project id of another space answers exactly like an unknown id (same
 * NOT_FOUND, no runner call, nothing written), and runner calls go to the server HOLDING the
 * project (new projects: the server of the space).
 *
 *   listProjects(ctx, { q, filter: 'tous'|'favoris'|'archives', sort, includeArchived })   D02 / M02
 *   getProjectDetail(ctx, id)            D04 / M04 (each runner part degrades on its own)
 *   listAddProjectRepos(ctx)             A1 (GitHub not connected = a state, not an error)
 *   getRepoPreview(ctx, fullName, src?)  D03 (branches, size, CLAUDE.md / lockfile, destination)
 *   checkProjectDestination(ctx, …)      D03 live check / A4
 *   createProject(ctx, input)            D03 « Cloner sur {serveur} » → { projectId, operationId } (A2 stream)
 *   retryProjectClone(ctx, id, …)        A4 / failed clone « Réessayer »
 *   syncProject(ctx, id)                 fetch + fast-forward pull (read token), T4 copy on failure
 *   branches / worktrees / runs / CLAUDE.md / env vars / MCP per project / favourite / archive
 *
 * Every mutation is audited (auditIn: actor, space, server). All disk / git / process work goes
 * through the runner of the project's server. Shapes: ./types (isomorphic, type-only imports from
 * client components).
 */

export * from './types';
export { findProject, gitIdentityOf, requireProject, type ProjectContext, type ProjectHandle } from './access';
export { listProjects, listProjectsQuerySchema, getProjectsDisk, type ListProjectsOptions } from './list';
export { getProjectDetail } from './detail';
export {
  listAddProjectRepos,
  getRepoPreview,
  checkProjectDestination,
  createProject,
  createProjectInputSchema,
  destinationCheckInputSchema,
  githubSourceIdSchema,
  retryProjectClone,
  retryCloneInputSchema,
  defaultFolderName,
  repoFullNameSchema,
  type CreateProjectInput,
} from './create';
export { syncProject, type SyncProjectResult } from './sync';
export {
  listProjectBranches,
  createProjectBranch,
  createBranchInputSchema,
  checkoutProjectBranch,
  checkoutInputSchema,
  listProjectWorktrees,
  previewWorktreeRemoval,
  removeProjectWorktree,
  removeWorktreeInputSchema,
  shapeBranches,
} from './branches';
export { startRun, startRunInputSchema, getRunDetail, stopRun, listRuns, listRunsQuerySchema, type RunDetail, type StartRunInput } from './runs';
export { readProjectClaudeMd, writeProjectClaudeMd, writeClaudeMdInputSchema } from './claude-md';
export {
  listEnvVars,
  createEnvVar,
  updateEnvVar,
  deleteEnvVar,
  createEnvVarInputSchema,
  updateEnvVarInputSchema,
  deleteEnvVarInputSchema,
  isProtectedEnvName,
  projectEnvSecretScope,
} from './env';
export { setProjectMcpTool, mcpServerHref } from './mcp';
export {
  updateProject,
  patchProjectInputSchema,
  markProjectOpened,
  getArchivePreview,
  archiveProject,
  archiveProjectInputSchema,
  restoreProject,
  discardFailedProject,
  type ArchivePreview,
  type PatchProjectInput,
} from './mutations';
export { projectErrorResponse, withProjectErrors, ProjectError, SYNC_REASON_COPY } from './errors';
