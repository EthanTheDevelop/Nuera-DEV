import 'server-only';

/**
 * Workspace lot — server module (D05 · M05 · W1–W7 · S1–S4). Every disk / git / process effect
 * goes through the runner client; GitHub through `@/server/github`. Contracts (Zod schemas, DTO
 * types, URL helpers) live in `@/features/workspace/lib/contract` (pure, also used by the browser).
 *
 *   const data = await getWorkspaceData(sessionId, user);           // page (null → 404)
 *   await sendInstruction(sessionId, text, user);  await interruptSession(sessionId);
 *   await decidePermission(permissionId, { optionId: 'allow' }, user);
 *   await commitChanges(worktreeId, { message, paths }, user); await pushBranch(worktreeId, {}, user);
 *   await openPullRequest(worktreeId, { title, body }, user);
 */
export { findSessionContext, requireSessionContext, requireWorktreeContext, repoName } from './access';
export { getSessionEventsPage, getWorkspaceData, readBranchStatus, readLatestPullRequest, readSessionEvents } from './data';
export { REASON_COPY, withWorkspaceErrors, workspaceErrorBody, type WorkspaceErrorBody } from './errors';
export { PREVIEW_MAX_CHARS, getFile, getTree, isSecretFile, type TreeView, type WorkspaceFileContent } from './files';
export {
  GIT_AUDIT_ACTIONS,
  commitChanges,
  getChanges,
  getDiff,
  getWorktreeStatus,
  openPullRequest,
  pushBranch,
  stagePaths,
  unstagePaths,
} from './git';
export {
  PERMISSION_AUDIT_ACTION,
  alwaysPrefix,
  decidePermission,
  decisionFromOption,
  permissionAuditSummary,
} from './permissions';
export { getSessionTerminal, interruptSession, sendInstruction, type WorkspaceActor } from './session-actions';
