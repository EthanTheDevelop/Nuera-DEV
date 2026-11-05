/**
 * Workspace lot — contracts shared by the browser (page, panels, dialogs) and the server module
 * (`@/server/workspace`, API routes). Pure: Zod schemas, types and URL helpers, no I/O.
 */
import type { PermissionMode, SessionBackend, SessionStatus } from '@nuera/db/schema';
import type {
  ChangesResponse,
  CliStatus,
  FileContent,
  FileDiff,
  GitStatus,
  PermissionRequestDto,
  SessionEventItem,
} from '@nuera/shared/runner';
import { isSafeRelativePath, isValidBranchName } from '@nuera/shared/paths';
import { z } from 'zod';

export type { PermissionMode, SessionBackend, SessionStatus };

/** Statuses during which a CLI process is expected to be alive. */
export const LIVE_STATUSES = ['running', 'waiting_permission', 'waiting_input'] as const satisfies readonly SessionStatus[];

export function isLiveStatus(status: SessionStatus): boolean {
  return (LIVE_STATUSES as readonly SessionStatus[]).includes(status);
}

// ---------------------------------------------------------------------------------------------
// Page data (getWorkspaceData)
// ---------------------------------------------------------------------------------------------

export interface WorkspaceSession {
  id: string;
  title: string;
  status: SessionStatus;
  /** A CLI process is attached right now (runner view); null when the runner did not answer. */
  live: boolean | null;
  /** Worktree present and conversation recorded (« reprise possible »). */
  resumable: boolean;
  backend: SessionBackend;
  /** tmux session name (`nuera-devis-express-remise`), null for the direct PTY backend. */
  tmuxName: string | null;
  permissionMode: PermissionMode;
  /** Model asked at launch (null = « défaut du CLI »). */
  model: string | null;
  /** Latest status line published by the CLI (model actually used…), never estimated. */
  cliStatus: CliStatus | null;
  queuedInstructions: number;
  currentActivity: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
}

export interface WorkspaceProject {
  id: string;
  name: string;
  slug: string;
  /** GitHub `owner/repo`. */
  fullName: string;
  /** Repository short name (`devis-express`) → « Claude Code est prêt dans devis-express ». */
  repoName: string;
  defaultBranch: string;
  htmlUrl: string;
  commands: { install: string | null; dev: string | null; build: string | null; test: string | null; lint: string | null };
  readClaudeMd: boolean;
}

export interface WorkspaceWorktree {
  id: string;
  name: string;
  branch: string;
  baseBranch: string | null;
  isPrimary: boolean;
  /** Not removed (a removed worktree cannot be read or resumed). */
  present: boolean;
}

/** Branch line of `Actions Git` (D05) / S3 `Branche`. */
export interface WorkspaceBranchStatus {
  branch: string | null;
  /** Comparison base (`main`). */
  base: string;
  ahead: number;
  behind: number;
  upstream: { name: string; ahead: number; behind: number } | null;
  dirtyFiles: number;
}

/** A session of the same project (W6 popover, S4 sheet). */
export interface SiblingSession {
  id: string;
  title: string;
  status: SessionStatus;
  branch: string | null;
  worktreeName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  current: boolean;
}

export interface WorkspacePullRequest {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  baseBranch: string;
  headBranch: string;
}

export interface WorkspaceEventsPage {
  items: SessionEventItem[];
  /** Highest version included (pass it back as `afterVersion`). */
  version: number;
  /** Every event up to `version` is included. */
  complete: boolean;
}

export interface WorkspaceData {
  session: WorkspaceSession;
  project: WorkspaceProject;
  worktree: WorkspaceWorktree | null;
  /** Pending (or moved to the terminal) permission request of the session. */
  permission: PermissionRequestDto | null;
  /** First page of the conversation; null when the runner could not be read. */
  events: WorkspaceEventsPage | null;
  branch: WorkspaceBranchStatus | null;
  changes: ChangesResponse | null;
  siblings: SiblingSession[];
  /** Live CLI processes / sessions allowed in parallel (Paramètres). */
  capacity: { live: number; max: number };
  /** CLAUDE.md of the worktree (W1 « CLAUDE.md lu »), null when unknown. */
  claudeMd: { exists: boolean; lines: number | null } | null;
  /** Latest pull request opened from this branch. */
  pullRequest: WorkspacePullRequest | null;
  /** Commands allowed during the session (permission log, W3 meta). */
  allowedCommands: number;
  runner: 'available' | 'unavailable';
  /** Owner identity used for commits (`Auteur`). */
  author: { name: string; email: string };
  generatedAt: string;
}

// ---------------------------------------------------------------------------------------------
// API inputs (Zod, shared by the routes and the browser)
// ---------------------------------------------------------------------------------------------

export const INSTRUCTION_MAX = 100_000;

export const sessionParamsSchema = z.object({ sessionId: z.uuid('session invalide') });
export const worktreeParamsSchema = z.object({ worktreeId: z.uuid('worktree invalide') });
export const permissionParamsSchema = z.object({ permissionId: z.uuid('demande invalide') });

export const instructionInputSchema = z
  .object({
    text: z
      .string()
      .max(INSTRUCTION_MAX, 'instruction trop longue')
      .refine((value) => value.trim().length > 0, 'instruction vide'),
  })
  .strict();
export type InstructionInput = z.infer<typeof instructionInputSchema>;

export const eventsQuerySchema = z.object({
  afterVersion: z.coerce.number().int().min(0).default(0),
});

export const PERMISSION_OPTION_IDS = ['allow', 'allow_always', 'deny'] as const;
export type PermissionOptionId = (typeof PERMISSION_OPTION_IDS)[number];

export const permissionDecisionInputSchema = z
  .object({
    optionId: z.enum(PERMISSION_OPTION_IDS, 'choix inconnu'),
    /** Message given to Claude on « Refuser ». */
    message: z.string().trim().max(2000, '2 000 caractères au maximum').optional(),
  })
  .strict();
export type PermissionDecisionInput = z.infer<typeof permissionDecisionInputSchema>;

const relativePath = z
  .string()
  .max(4096, 'chemin trop long')
  .refine((value) => value === '' || isSafeRelativePath(value), 'chemin relatif invalide');
const requiredPath = relativePath.refine((value) => value.length > 0, 'chemin requis');

export const treeQuerySchema = z.object({ path: relativePath.default('') });
export const fileQuerySchema = z.object({ path: requiredPath });
export const diffQuerySchema = z.object({
  path: requiredPath,
  against: z.enum(['head', 'staged']).default('head'),
});
export const pathsInputSchema = z.object({ paths: z.array(requiredPath).min(1, 'aucun fichier').max(2000) }).strict();

export const commitInputSchema = z
  .object({
    message: z.string().trim().min(1, 'message de commit requis').max(500, '500 caractères au maximum'),
    body: z.string().max(20_000, 'description trop longue').optional(),
    /** Commit exactly these paths (staged first). */
    paths: z.array(requiredPath).min(1, 'aucun fichier sélectionné').max(2000),
    sessionId: z.uuid().optional(),
  })
  .strict();
export type CommitInput = z.infer<typeof commitInputSchema>;

export const pushInputSchema = z.object({ sessionId: z.uuid().optional() }).strict();

export const pullRequestInputSchema = z
  .object({
    title: z.string().trim().min(1, 'titre requis').max(256, '256 caractères au maximum'),
    body: z.string().max(65_000, 'description trop longue').optional(),
    /** Target branch (default: the worktree base, else the project default branch). */
    base: z.string().trim().min(1).max(255).refine(isValidBranchName, 'nom de branche invalide').optional(),
    draft: z.boolean().optional(),
    sessionId: z.uuid().optional(),
  })
  .strict();
export type PullRequestInput = z.infer<typeof pullRequestInputSchema>;

// ---------------------------------------------------------------------------------------------
// API results
// ---------------------------------------------------------------------------------------------

export interface InstructionResult {
  delivered: boolean;
  queued: boolean;
  started: boolean;
  resumed: boolean;
  status: SessionStatus;
  queuedInstructions: number;
}

export interface TerminalResult {
  terminalId: string | null;
  live: boolean;
}

export interface CommitResultView {
  sha: string;
  shortSha: string;
  branch: string | null;
  filesCommitted: number;
  insertions: number;
  deletions: number;
}

export interface PushResultView {
  branch: string;
  remoteBranch: string;
  headSha: string;
  upToDate: boolean;
  createdRemoteBranch: boolean;
  /** GitHub page of the pushed branch. */
  url: string;
}

export interface WorktreeStatusView {
  status: GitStatus;
  branch: WorkspaceBranchStatus;
}

export type { ChangesResponse, FileContent, FileDiff, GitStatus, PermissionRequestDto, SessionEventItem };

// ---------------------------------------------------------------------------------------------
// URL state (overview.md §6)
// ---------------------------------------------------------------------------------------------

export const VIEW_VALUES = ['conversation', 'terminal'] as const;
export type WorkspaceView = (typeof VIEW_VALUES)[number];

export const PANEL_VALUES = ['fichiers', 'modifications', 'tests', 'terminal', 'projet', 'ferme'] as const;
export type WorkspacePanel = (typeof PANEL_VALUES)[number];

export const PHONE_TAB_VALUES = ['session', 'fichiers', 'diff', 'git'] as const;
export type WorkspacePhoneTab = (typeof PHONE_TAB_VALUES)[number];

export const DIFF_LAYOUT_VALUES = ['unifie', 'cote-a-cote'] as const;
export type DiffLayoutParam = (typeof DIFF_LAYOUT_VALUES)[number];

export function workspaceUrl(sessionId: string): string {
  return `/workspace/${encodeURIComponent(sessionId)}`;
}

export function pick<T extends string>(values: readonly T[], value: string | null | undefined, fallback: T): T {
  return value && (values as readonly string[]).includes(value) ? (value as T) : fallback;
}
