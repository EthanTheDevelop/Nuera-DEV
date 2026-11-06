import 'server-only';

/**
 * Multi-account model of the web (docs/MULTICOMPTE.md §5): request context (account → space →
 * server) and resource scoping (resource → space check → server holding it).
 */
export {
  getRequestContext,
  invalidateContextCache,
  NO_ENVIRONMENT_MESSAGE,
  personalSpaceName,
  requireContext,
  requireContextForApi,
  requireEnvironment,
  resolveContext,
  type EnvironmentRef,
  type RequestContext,
  type SpaceRef,
} from './context';
export {
  auditIn,
  inSpace,
  invalidateTerminalScope,
  NOT_FOUND_MESSAGES,
  ofSpace,
  scopeOfOperation,
  scopeOfPermission,
  scopeOfProject,
  scopeOfRun,
  scopeOfSession,
  scopeOfTerminal,
  scopeOfTerminalInput,
  scopeOfWorktree,
  TERMINAL_ID_PATTERN,
  type OperationScope,
  type PermissionScope,
  type ProjectScope,
  type ResourceScope,
  type RunScope,
  type ScopedAuditEntry,
  type ScopeOptions,
  type SessionScope,
  type TerminalScope,
  type WorktreeScope,
} from './scope';
