import 'server-only';

/**
 * Sessions lot — server module (life cycle of the Claude Code sessions, D06 lists, capacity).
 * Every function takes the request context first (docs/MULTICOMPTE.md §5): lists are limited to
 * its space, and each session is driven on the server holding its project.
 *
 *   import { createSession, listSessions, getCapacity } from '@/server/sessions';
 *   const ctx = await requireContext();
 *   await listSessions(ctx, { status: 'active' });
 *
 * Contracts (Zod schemas, DTO types, URL helpers) live in `@/features/sessions/lib/contract`
 * (pure, also used by the browser).
 */
export {
  SESSION_AUDIT_ACTIONS,
  archiveSession,
  buildLaunchOptions,
  createSession,
  renameSession,
  resumeAfterLimitNow,
  resumeSession,
  sendFirstInstruction,
  setSessionAutoResume,
  startNewSession,
  stopSession,
  type SessionActionResult,
  type SessionActorContext,
} from './service';
export {
  capacityMessage,
  databaseLiveCount,
  environmentMaxSessions,
  getCapacity,
  getSessionItem,
  getSessionSummary,
  listSessionProjects,
  listSessions,
  summaryPoints,
  type ListSessionsInput,
} from './queries';
export { getNewSessionOptions, getProjectBranchOptions, projectUnavailableReason } from './options';
export { buildSessionEnv, isSessionEnvNameAllowed } from './env';
export { PROJECT_NOT_FOUND, assertCanDriveSession, canDriveSession } from './access';
export { getGitIdentity, resolveGitIdentity } from './git-identity';
export {
  createSessionInputSchema,
  listSessionsQuerySchema,
  renameSessionInputSchema,
  sessionIdParamsSchema,
  workspaceUrl,
  type CreateSessionInput,
  type CreateSessionResult,
  type NewSessionOptions,
  type ProjectBranchOptions,
  type SessionCapacity,
  type SessionListItem,
  type SessionListPage,
  type SessionServer,
  type SessionSummary,
} from '@/features/sessions/lib/contract';
