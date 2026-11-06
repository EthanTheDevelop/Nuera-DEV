import 'server-only';

/**
 * Workspace lot — server module (D05 · M05 · W1–W7 · S1–S4). Every function takes the request
 * context first (docs/MULTICOMPTE.md §5): the session, worktree or permission must be one of its
 * space (an id of another space answers like an unknown id), and every disk / git / process effect
 * goes through the runner of the server holding the project; GitHub through the project's source
 * (`@/server/github`). Contracts (Zod schemas, DTO types, URL helpers) live in
 * `@/features/workspace/lib/contract` (pure, also used by the browser).
 *
 *   const data = await getWorkspaceData(ctx, sessionId);             // page (null → 404)
 *   await sendInstruction(ctx, sessionId, text);  await interruptSession(ctx, sessionId);
 *   await decidePermission(ctx, permissionId, { optionId: 'allow' });
 *   await commitChanges(ctx, worktreeId, { message, paths }); await pushBranch(ctx, worktreeId, {});
 *   await openPullRequest(ctx, worktreeId, { title, body });
 */
export { findSessionContext, requireSessionContext, requireWorktreeContext, repoName, type SessionContext, type WorktreeContext } from './access';
export { getSessionEventsPage, getWorkspaceData } from './data';
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
export { getSessionTerminal, interruptSession, sendInstruction } from './session-actions';
