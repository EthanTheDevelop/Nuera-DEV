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
  | 'clone_remove'
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

/**
 * One `integrations` row per space and kind. GitHub is no longer an `integrations` row: each space
 * has its own `github_sources` (migration 0002 moved the former `github` row there, same id).
 */
export type IntegrationKind = 'coolify' | 'figma';
export type IntegrationStatus = 'pending' | 'connected' | 'expiring' | 'expired' | 'error' | 'disconnected';

export type McpTransport = 'http' | 'sse' | 'stdio';
export type McpAuthKind = 'none' | 'bearer' | 'header' | 'env' | 'oauth';

/** Non-secret settings of an MCP server (secrets stay in `secretsEncrypted`). */
export interface McpServerConfig {
  /** Built-in preset the server was created from ("figma", "github", "coolify", "playwright"…). */
  presetId?: string;
  /** Static, non-secret HTTP headers sent with every request. */
  headers?: Record<string, string>;
  /** Tool names Claude Code must not call on this server (added to the session deny rules). */
  denyTools?: string[];
}

/** Structured result of a run, stored when the process ends (test report parsed from the output). */
export interface CommandRunDetails {
  report?: {
    counts: {
      passed: number;
      failed: number;
      skipped: number;
      running: number;
      total: number;
      durationMs: number | null;
      framework: 'vitest' | 'jest' | 'playwright' | 'node' | 'unknown';
    };
    tests: Array<{ name: string; status: 'passed' | 'failed' | 'running' | 'skipped'; durationMs: number | null; location: string | null }>;
    failures: Array<{ name: string; location: string | null; excerpt: string }>;
  };
}
export type McpStatus = 'connected' | 'needs_auth' | 'expired' | 'error' | 'disabled' | 'unknown';

export type NotificationKind =
  | 'permission_request'
  /** The CLI shows an interactive screen (login, trust…) waiting for an answer in its terminal. */
  | 'session_attention'
  | 'session_finished'
  | 'session_failed'
  | 'session_interrupted'
  | 'operation_failed'
  | 'operation_succeeded'
  | 'integration_expiring'
  | 'integration_expired'
  | 'integration_error'
  | 'claude_disconnected'
  | 'server'
  | 'security';

export type Severity = 'info' | 'success' | 'warning' | 'danger';

export type ThemePreference = 'light' | 'dark' | 'system';

// ---------------------------------------------------------------------------------------------
// Accounts, spaces and servers (docs/MULTICOMPTE.md §2–§4)
// ---------------------------------------------------------------------------------------------

/** `user.role` — « Propriétaire » (exactly one, `user_owner_idx`) · « Administrateur » · « Membre ». */
export type InstanceRole = 'owner' | 'admin' | 'member';

/** `spaces.kind` — only `personal` in v1 (one per account). */
export type SpaceKind = 'personal' | 'shared';

/** `space_members.role`. */
export type SpaceRole = 'owner' | 'member';

/**
 * `environments.status` (« serveur »):
 * - `pending`: registered, never used (may be pre-assigned to an invitation);
 * - `active`: assigned to a space and in use;
 * - `suspended`: the account of its space is disabled — no new work, reading and stopping still allowed;
 * - `retired`: never reassigned; a new server is created instead.
 */
export type EnvironmentStatus = 'pending' | 'active' | 'suspended' | 'retired';

/** `environments.config_source`: `env` = URL and token read from RUNNER_URL / RUNNER_TOKEN; `db` = stored row. */
export type EnvironmentConfigSource = 'env' | 'db';

/**
 * `environments.capabilities`, written by the runner heartbeat. Tool availability only: never a
 * field of the Claude account (`~/.claude.json`), never a cost or quota.
 */
export interface EnvironmentCapabilities {
  hostname?: string | null;
  platform?: string | null;
  claudeVersion?: string | null;
  gitVersion?: string | null;
  tmuxVersion?: string | null;
  /**
   * Role of the runner's database connections (heartbeat). `restricted`: neither superuser nor
   * owner of the tables (the dedicated role of MULTICOMPTE §11); the console warns otherwise.
   */
  database?: { role: string; restricted: boolean } | null;
}

/** `invitations.kind`: an invitation to create an account, or a single-use recovery link (password + TOTP). */
export type InvitationKind = 'invite' | 'recovery';

/** `github_sources.kind`: a GitHub App (`app`); `pat` is reserved. */
export type GithubSourceKind = 'app' | 'pat';
