/**
 * Shared union types for text columns and JSON payloads.
 * Status columns are plain `text` typed with these unions (no pg enums) so that adding a value
 * never requires an ALTER TYPE migration. Validate at the boundaries with Zod (@nuera/shared).
 */

export type ProjectStatus = 'cloning' | 'ready' | 'error' | 'archived';
export type SyncState = 'up_to_date' | 'behind' | 'ahead' | 'diverged' | 'no_upstream' | 'unknown';

export interface ProjectCommands {
  install?: string | null;
  dev?: string | null;
  build?: string | null;
  test?: string | null;
  lint?: string | null;
}

export interface ProjectOptions {
  /** Installer les dépendances après le clonage. */
  installDeps: boolean;
  /** Un worktree dédié par nouvelle session. */
  worktreePerSession: boolean;
  /** Claude lit CLAUDE.md (défaut du CLI) — affiché, non modifiable côté CLI. */
  readClaudeMd: boolean;
}

export type WorktreeStatus = 'active' | 'missing' | 'removed';

export type SessionStatus =
  | 'new'
  | 'running'
  | 'waiting_permission'
  | 'waiting_input'
  | 'stopped'
  | 'interrupted'
  | 'failed'
  | 'finished'
  | 'archived';

export type SessionBackend = 'tmux' | 'pty';

/** Permission modes accepted by `claude --permission-mode` (CLI 2.1.x). */
export type PermissionMode = 'manual' | 'acceptEdits' | 'auto' | 'plan' | 'dontAsk' | 'bypassPermissions';

export type SessionEventKind =
  | 'instruction'
  | 'assistant'
  | 'tool'
  | 'plan'
  | 'permission'
  | 'notification'
  | 'status'
  | 'error'
  | 'compact'
  | 'subagent'
  | 'system';

export type PermissionRequestStatus =
  | 'pending'
  | 'allowed'
  | 'allowed_always'
  | 'denied'
  | 'expired'
  | 'answered_in_terminal'
  | 'cancelled';

export type OperationKind =
  | 'clone'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'commit'
  | 'branch_create'
  | 'checkout'
  | 'worktree_create'
  | 'worktree_remove'
  | 'install'
  | 'pr_create'
  | 'archive'
  | 'claude_md_update'
  | 'integration_check'
  | 'mcp_check'
  | 'maintenance';

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface OperationStep {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
}

export interface OperationError {
  code: string;
  message: string;
  /** What was not touched (règle T4). */
  untouched?: string;
  /** Raw command output, shown "à un clic". */
  raw?: string;
}

export type CommandKind = 'install' | 'dev' | 'build' | 'test' | 'lint' | 'custom';
export type CommandRunStatus = 'running' | 'succeeded' | 'failed' | 'stopped';

export type PullRequestState = 'open' | 'closed' | 'merged';

export type IntegrationKind = 'github' | 'coolify' | 'figma';
export type IntegrationStatus = 'pending' | 'connected' | 'expiring' | 'expired' | 'error' | 'disconnected';

export type McpTransport = 'http' | 'sse' | 'stdio';
export type McpAuthKind = 'none' | 'bearer' | 'header' | 'env' | 'oauth';
export type McpStatus = 'connected' | 'needs_auth' | 'expired' | 'error' | 'disabled' | 'unknown';

export type NotificationKind =
  | 'permission_request'
  | 'session_finished'
  | 'session_failed'
  | 'session_interrupted'
  | 'operation_failed'
  | 'operation_succeeded'
  | 'integration_expiring'
  | 'integration_expired'
  | 'claude_disconnected'
  | 'server'
  | 'security';

export type Severity = 'info' | 'success' | 'warning' | 'danger';

export type ThemePreference = 'light' | 'dark' | 'system';
