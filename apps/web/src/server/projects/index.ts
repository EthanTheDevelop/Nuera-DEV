import 'server-only';

/**
 * Projets domain (D02/M02 list, D03 + A1–A4 / M03 add flow, D04/M04 project page) — public API.
 *
 *   listProjects({ q, filter: 'tous'|'favoris'|'archives', sort, includeArchived })   D02 / M02
 *   getProjectDetail(id)            D04 / M04 (each runner part degrades on its own)
 *   listAddProjectRepos()           A1 (GitHub not connected = a state, not an error)
 *   getRepoPreview(fullName)        D03 (branches, size, CLAUDE.md / lockfile when GitHub serves them, destination)
 *   checkProjectDestination(...)    D03 live check / A4
 *   createProject(input, actor)     D03 « Cloner sur VPS-3 » → { projectId, operationId } (A2 stream)
 *   retryProjectClone(id, ...)      A4 / failed clone « Réessayer »
 *   syncProject(id, actor)          fetch + fast-forward pull (read token), T4 copy on failure
 *   branches / worktrees / runs / CLAUDE.md / env vars / MCP per project / favourite / archive
 *
 * Every mutation is audited. All disk / git / process work goes through the runner.
 * Shapes: ./types (isomorphic, type-only imports from client components).
 */

export * from './types';
export { listProjects, listProjectsQuerySchema, getProjectsDisk, type ListProjectsOptions } from './list';
export { getProjectDetail } from './detail';
export {
  listAddProjectRepos,
  getRepoPreview,
  checkProjectDestination,
  createProject,
  createProjectInputSchema,
  destinationCheckInputSchema,
  retryProjectClone,
  retryCloneInputSchema,
  getCloneOperation,
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
  decryptedEnvForRuns,
  isProtectedEnvName,
} from './env';
export { listProjectMcpTools, setProjectMcpTool, mcpServerHref } from './mcp';
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
export { listProjectSessionRows, requireProjectRow, requireReadyProject } from './queries';
export { projectErrorResponse, withProjectErrors, ProjectError, SYNC_REASON_COPY } from './errors';
