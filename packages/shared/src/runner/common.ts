import { z } from 'zod';
import { isValidBranchName, isValidRepoFullName, isValidWorktreeName, isSafeRelativePath } from '../paths';

/**
 * Enumerations mirrored from `packages/db/src/schema/types.ts` (text unions in the database).
 * The runner asserts at compile time that both stay identical.
 */
export const SESSION_STATUSES = [
  'new',
  'running',
  'waiting_permission',
  'waiting_input',
  'stopped',
  'interrupted',
  'failed',
  'finished',
  'archived',
] as const;
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatusValue = z.infer<typeof SessionStatusSchema>;

/** Statuses during which a CLI process is expected to be alive. */
export const LIVE_SESSION_STATUSES = ['running', 'waiting_permission', 'waiting_input'] as const;

export const SESSION_BACKENDS = ['tmux', 'pty'] as const;
export const SessionBackendSchema = z.enum(SESSION_BACKENDS);

export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'] as const;
export const PermissionModeSchema = z.enum(PERMISSION_MODES);
export type PermissionModeValue = z.infer<typeof PermissionModeSchema>;

export const SESSION_EVENT_KINDS = [
  'instruction',
  'assistant',
  'tool',
  'plan',
  'permission',
  'notification',
  'status',
  'error',
  'compact',
  'subagent',
  'system',
] as const;
export const SessionEventKindSchema = z.enum(SESSION_EVENT_KINDS);

export const PERMISSION_REQUEST_STATUSES = [
  'pending',
  'allowed',
  'allowed_always',
  'denied',
  'expired',
  'answered_in_terminal',
  'cancelled',
] as const;
export const PermissionRequestStatusSchema = z.enum(PERMISSION_REQUEST_STATUSES);

export const OPERATION_KINDS = [
  'clone',
  'fetch',
  'pull',
  'push',
  'commit',
  'branch_create',
  'checkout',
  'worktree_create',
  'worktree_remove',
  'clone_remove',
  'install',
  'pr_create',
  'archive',
  'claude_md_update',
  'integration_check',
  'mcp_check',
  'maintenance',
] as const;
export const OperationKindSchema = z.enum(OPERATION_KINDS);
export const OPERATION_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const OperationStatusSchema = z.enum(OPERATION_STATUSES);

export const COMMAND_KINDS = ['install', 'dev', 'build', 'test', 'lint', 'custom'] as const;
export const CommandKindSchema = z.enum(COMMAND_KINDS);
export const COMMAND_RUN_STATUSES = ['running', 'succeeded', 'failed', 'stopped'] as const;
export const CommandRunStatusSchema = z.enum(COMMAND_RUN_STATUSES);

export const SYNC_STATES = ['up_to_date', 'behind', 'ahead', 'diverged', 'no_upstream', 'unknown'] as const;
export const SyncStateSchema = z.enum(SYNC_STATES);

export const WORKTREE_STATUSES = ['active', 'missing', 'removed'] as const;
export const WorktreeStatusSchema = z.enum(WORKTREE_STATUSES);

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Same vocabulary as the web `AppError` codes (minus RUNNER_UNAVAILABLE, produced by the web client). */
export const RUNNER_ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION',
  'CONFLICT',
  'RATE_LIMITED',
  'UPSTREAM',
  'INTERNAL',
] as const;
export const RunnerErrorCodeSchema = z.enum(RUNNER_ERROR_CODES);
export type RunnerErrorCode = z.infer<typeof RunnerErrorCodeSchema>;

export const RUNNER_ERROR_STATUS: Record<RunnerErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UPSTREAM: 502,
  INTERNAL: 500,
};

/**
 * Machine-readable sub-codes carried in `error.reason` (the UI picks copy/actions from them).
 * Free-form strings stay accepted so a newer runner never breaks an older web build.
 */
export const RUNNER_ERROR_REASONS = [
  'DESTINATION_NOT_EMPTY',
  'DESTINATION_OUTSIDE_ROOT',
  'PATH_REJECTED',
  'PROJECT_NOT_READY',
  'WORKTREE_DIRTY',
  'WORKTREE_IN_USE',
  'WORKTREE_MISSING',
  'BRANCH_EXISTS',
  'BRANCH_NOT_FOUND',
  'BRANCH_PROTECTED',
  'NOTHING_TO_COMMIT',
  'PULL_DIVERGED',
  'PULL_CONFLICT',
  'PULL_DIRTY',
  'NO_UPSTREAM',
  'PUSH_REJECTED',
  'GIT_AUTH_FAILED',
  /** The repository's own Git config would redirect or weaken a network command (url/http/protocol keys). */
  'GIT_CONFIG_UNSAFE',
  'GIT_FAILED',
  'TIMEOUT',
  'CAPACITY_REACHED',
  'SESSION_NOT_LIVE',
  'SESSION_BUSY_PERMISSION',
  'SESSION_NOT_RESUMABLE',
  'PERMISSION_NOT_PENDING',
  'PERMISSION_NO_LISTENER',
  'BYPASS_BLOCKED',
  'CLAUDE_NOT_INSTALLED',
  /** Shared server (contract 3): the request must name the account whose Claude connection it uses. */
  'CLAUDE_ACCOUNT_REQUIRED',
  /** The account still works on the server: its Claude config folder is kept. */
  'CLAUDE_ACCOUNT_IN_USE',
  /** The account's Claude config folder is a link or a file: refused, never followed. */
  'CLAUDE_ACCOUNT_FOLDER',
  'FILE_TOO_LARGE',
  'BINARY_FILE',
  'TERMINAL_CLOSED',
  'RUN_LIMIT',
  /** 503: the runner's token matches no registered server (or a retired one); it waits, health only. */
  'ENVIRONMENT_UNREGISTERED',
  /** 503: the runner found its server but does not serve yet (another runner still holds its lease, or start-up tasks run). */
  'ENVIRONMENT_STARTING',
  /** The server is suspended or retired: no new session, clone, run nor shell terminal (reading and stopping stay possible). */
  'ENVIRONMENT_DISABLED',
  /** Aperçu: the run is not a dev server (`kind` other than `dev`). */
  'PREVIEW_NOT_DEV',
  /** Aperçu: the dev server of the run is not running any more (or never ran in this runner process). */
  'PREVIEW_NOT_RUNNING',
  /** Aperçu: no port detected yet in the dev server's output. */
  'PREVIEW_NO_PORT',
  /** Aperçu: nothing answers on the detected port (loopback). */
  'PREVIEW_UNREACHABLE',
  /** Aperçu: request or response body over the limit. */
  'PREVIEW_TOO_LARGE',
  /** A dev server of that name already runs in this worktree (another name may run beside it). */
  'DEV_SERVER_RUNNING',
] as const;
export type RunnerErrorReason = (typeof RUNNER_ERROR_REASONS)[number];

export const RunnerErrorBodySchema = z.object({
  error: z.object({
    code: RunnerErrorCodeSchema,
    message: z.string(),
    detail: z.string().optional(),
    /** Raw command output, shown « à un clic » (rule T4). Secrets are redacted by the runner. */
    raw: z.string().optional(),
    /** What was NOT touched (rule T4: « Rien n'a été écrasé. »). */
    untouched: z.string().optional(),
    reason: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type RunnerErrorBody = z.infer<typeof RunnerErrorBodySchema>;

// ---------------------------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------------------------

export const UuidSchema = z.uuid();
export const IsoDateSchema = z.string();

export const BranchNameSchema = z
  .string()
  .trim()
  .refine(isValidBranchName, { message: 'Nom de branche invalide.' });

export const WorktreeNameSchema = z
  .string()
  .trim()
  .refine(isValidWorktreeName, { message: 'Nom de worktree invalide (a-z, 0-9, . _ -).' });

export const RepoFullNameSchema = z
  .string()
  .trim()
  .refine(isValidRepoFullName, { message: 'Dépôt GitHub invalide (propriétaire/dépôt).' });

/** Path relative to a worktree (`''` = root). Normalised again by the runner. */
export const RelativePathSchema = z
  .string()
  .max(4096)
  .refine((value) => value === '' || isSafeRelativePath(value), { message: 'Chemin relatif invalide.' });

/** Value for `http.<base>.extraheader` (« AUTHORIZATION: basic … »), minted by the web per operation. */
export const GitExtraHeaderSchema = z
  .string()
  .min(10)
  .max(4096)
  .regex(/^AUTHORIZATION: (basic|bearer) [A-Za-z0-9+/=._~-]+$/i, { message: 'En-tête Git invalide.' });

export const GitIdentitySchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().min(3).max(320).regex(/^[^\s<>]+@[^\s<>]+$/),
});
export type GitIdentity = z.infer<typeof GitIdentitySchema>;

/** Boolean in a query string (`1`, `true`, `0`, `false`). */
export const QueryBooleanSchema = z
  .union([z.boolean(), z.enum(['1', '0', 'true', 'false', 'yes', 'no'])])
  .transform((value) => value === true || value === '1' || value === 'true' || value === 'yes');

export const OkResponseSchema = z.object({ ok: z.literal(true) });
