import 'server-only';

/**
 * Sessions lot — server module (life cycle of the Claude Code sessions, D06 lists, capacity).
 *
 *   import { createSession, listSessions, getCapacity } from '@/server/sessions';
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
  resumeSession,
  sendFirstInstruction,
  stopSession,
  type SessionActionResult,
  type SessionActor,
} from './service';
export {
  capacityMessage,
  getCapacity,
  getSessionItem,
  getSessionSummary,
  listSessionProjects,
  listSessions,
  summaryPoints,
  type ListSessionsInput,
} from './queries';
export { getNewSessionOptions, getProjectBranchOptions } from './options';
export { buildSessionEnv, isSessionEnvNameAllowed, readProjectEnv } from './env';
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
  type SessionSummary,
} from '@/features/sessions/lib/contract';
