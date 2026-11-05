import { z } from 'zod';
import {
  BranchNameSchema,
  GitExtraHeaderSchema,
  GitIdentitySchema,
  IsoDateSchema,
  QueryBooleanSchema,
  RelativePathSchema,
  RepoFullNameSchema,
  SyncStateSchema,
  UuidSchema,
  WorktreeNameSchema,
  WorktreeStatusSchema,
} from './common';
import { OperationDtoSchema } from './operations';

// ---------------------------------------------------------------------------------------------
// Clone (async operation, parcours A2/A3/A4)
// ---------------------------------------------------------------------------------------------

export const CheckDestinationRequestSchema = z.object({
  /** Absolute path, or path relative to NUERA_PROJECTS_ROOT. */
  path: z.string().min(1).max(4096),
  /** `owner/repo` being cloned, to recognise an existing clone of the same repository. */
  fullName: RepoFullNameSchema.optional(),
});

export const DestinationCheckSchema = z.object({
  /** Real absolute path that would be used. */
  path: z.string(),
  exists: z.boolean(),
  empty: z.boolean(),
  /** Entries in the folder (top level), 0 when it does not exist. */
  fileCount: z.number().int(),
  /** The folder already holds a git clone. */
  existingClone: z
    .object({
      remoteUrl: z.string().nullable(),
      fullName: z.string().nullable(),
      branch: z.string().nullable(),
      sameRepository: z.boolean(),
    })
    .nullable(),
  /** A free sibling path (« /srv/dev/roux-conseil-landing »), when the folder is not usable. */
  suggestedPath: z.string().nullable(),
  /** True when the clone can proceed into `path`. */
  available: z.boolean(),
});
export type DestinationCheck = z.infer<typeof DestinationCheckSchema>;

export const CloneRequestSchema = z.object({
  /** Project row created by the web beforehand (status `cloning`); the runner updates it. */
  projectId: UuidSchema,
  fullName: RepoFullNameSchema,
  /** Branch to check out (default: the remote HEAD). */
  branch: BranchNameSchema.optional(),
  /** Absolute path, or relative to NUERA_PROJECTS_ROOT. Must not exist or be empty. */
  destination: z.string().min(1).max(4096),
  /** Read token header for github.com (from `getGitAuthForRepo(fullName, 'read')`). Absent = public repo. */
  extraHeader: GitExtraHeaderSchema.optional(),
  /** Install dependencies after the clone (lockfile-detected command, run through the platform shell). */
  installDeps: z.boolean().default(true),
  /** Explicit install command (overrides detection). */
  installCommand: z.string().trim().min(1).max(1000).optional(),
  actorUserId: z.string().nullish(),
});
export type CloneRequest = z.input<typeof CloneRequestSchema>;

export const CloneResultSchema = z.object({
  projectId: UuidSchema,
  path: z.string(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  worktreeId: UuidSchema,
  /** `package.json` scripts found among dev/build/test/lint (+ others). */
  scripts: z.array(z.string()),
  /** Commands proposed for the project (`npm run dev`…), null when none detected. */
  commands: z.object({
    install: z.string().nullable(),
    dev: z.string().nullable(),
    build: z.string().nullable(),
    test: z.string().nullable(),
    lint: z.string().nullable(),
  }),
  packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).nullable(),
  claudeMd: z.object({ found: z.boolean(), location: z.string().nullable(), lines: z.number().int().nullable() }),
  install: z
    .object({ command: z.string(), exitCode: z.number().int().nullable(), durationMs: z.number(), packages: z.number().int().nullable() })
    .nullable(),
  receivedBytes: z.number().nullable(),
});
export type CloneResult = z.infer<typeof CloneResultSchema>;

export const OperationStartedResponseSchema = z.object({ operationId: UuidSchema, operation: OperationDtoSchema });

// ---------------------------------------------------------------------------------------------
// Fetch / pull / sync
// ---------------------------------------------------------------------------------------------

export const FetchRequestSchema = z.object({
  extraHeader: GitExtraHeaderSchema.optional(),
  actorUserId: z.string().nullish(),
});

export const SyncStatusSchema = z.object({
  projectId: UuidSchema,
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int(),
  behind: z.number().int(),
  state: SyncStateSchema,
  lastFetchedAt: IsoDateSchema.nullable(),
  headSha: z.string().nullable(),
  headMessage: z.string().nullable(),
  headDate: IsoDateSchema.nullable(),
  dirtyFiles: z.number().int(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

export const FetchResultSchema = z.object({ operationId: UuidSchema.nullable(), sync: SyncStatusSchema });

export const PullRequestBodySchema = z.object({
  extraHeader: GitExtraHeaderSchema.optional(),
  /** `ff-only` (default) never creates commits; `rebase` and `merge` need an identity. */
  mode: z.enum(['ff-only', 'rebase', 'merge']).default('ff-only'),
  identity: GitIdentitySchema.optional(),
  /** Pull into a worktree instead of the primary clone. */
  worktreeId: UuidSchema.optional(),
  actorUserId: z.string().nullish(),
});

export const PullOutcomeSchema = z.enum(['up_to_date', 'fast_forward', 'rebased', 'merged']);
export const PullResultSchema = z.object({
  operationId: UuidSchema.nullable(),
  outcome: PullOutcomeSchema,
  before: z.string().nullable(),
  after: z.string().nullable(),
  /** Commits brought in. */
  commits: z.number().int(),
  sync: SyncStatusSchema,
});
export type PullResult = z.infer<typeof PullResultSchema>;

// ---------------------------------------------------------------------------------------------
// Status / branches / log
// ---------------------------------------------------------------------------------------------

/** One entry of `git status --porcelain=v2`. `index`/`worktree` are the X/Y letters (`.` = unchanged). */
export const StatusFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  kind: z.enum(['changed', 'renamed', 'unmerged', 'untracked', 'ignored']),
  index: z.string(),
  worktree: z.string(),
  staged: z.boolean(),
  unstaged: z.boolean(),
  conflicted: z.boolean(),
});
export type StatusFile = z.infer<typeof StatusFileSchema>;

export const GitStatusSchema = z.object({
  branch: z.string().nullable(),
  detached: z.boolean(),
  headSha: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int(),
  behind: z.number().int(),
  files: z.array(StatusFileSchema),
  clean: z.boolean(),
  counts: z.object({
    staged: z.number().int(),
    unstaged: z.number().int(),
    untracked: z.number().int(),
    conflicted: z.number().int(),
  }),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

export const StatusQuerySchema = z.object({ worktreeId: UuidSchema.optional() });

export const BranchSchema = z.object({
  name: z.string(),
  /** `local` branch or `remote` tracking branch (`origin/feature/x` → name `feature/x`, remote `origin`). */
  kind: z.enum(['local', 'remote']),
  remote: z.string().nullable(),
  current: z.boolean(),
  headSha: z.string(),
  subject: z.string(),
  committedAt: IsoDateSchema.nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  /** Merged into the default branch (`git branch --merged <default>`). */
  merged: z.boolean(),
  protected: z.boolean(),
  isDefault: z.boolean(),
  worktreeId: UuidSchema.nullable(),
  worktreeName: z.string().nullable(),
  sessionId: UuidSchema.nullable(),
});
export type Branch = z.infer<typeof BranchSchema>;

export const BranchesQuerySchema = z.object({
  /** Comma-separated protected branch names (from the project settings). */
  protected: z.string().max(2000).optional(),
});
export const BranchesResponseSchema = z.object({ defaultBranch: z.string(), branches: z.array(BranchSchema) });

export const CreateBranchRequestSchema = z.object({
  name: BranchNameSchema,
  /** Start point (branch, tag or sha). Default: the project's default branch. */
  from: z.string().trim().min(1).max(200).optional(),
  checkout: z.boolean().default(false),
  worktreeId: UuidSchema.optional(),
  actorUserId: z.string().nullish(),
});
export const CheckoutRequestSchema = z.object({
  branch: BranchNameSchema,
  worktreeId: UuidSchema.optional(),
  /** Create the local branch tracking `origin/<branch>` when only the remote one exists. */
  track: z.boolean().default(true),
  actorUserId: z.string().nullish(),
});
export const BranchResultSchema = z.object({ operationId: UuidSchema.nullable(), branch: z.string(), headSha: z.string().nullable() });

export const CommitSummarySchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  body: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  authoredAt: IsoDateSchema,
});
export type CommitSummary = z.infer<typeof CommitSummarySchema>;

export const LogQuerySchema = z.object({
  n: z.coerce.number().int().min(1).max(200).default(20),
  ref: z.string().trim().min(1).max(200).optional(),
  worktreeId: UuidSchema.optional(),
});
export const LogResponseSchema = z.object({ commits: z.array(CommitSummarySchema) });

// ---------------------------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------------------------

export const WorktreeDtoSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  name: z.string(),
  branch: z.string(),
  baseBranch: z.string().nullable(),
  path: z.string(),
  isPrimary: z.boolean(),
  status: WorktreeStatusSchema,
  createdAt: IsoDateSchema,
  lastUsedAt: IsoDateSchema.nullable(),
  /** Live data (null when git could not be read). */
  dirtyFiles: z.number().int().nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  liveSessionId: UuidSchema.nullable(),
  /**
   * Disk space of the folder (like `du -s`, `.git` included for the primary clone), only when asked
   * (`?sizes=1`). null = not measured: unreadable, or too large to walk within the runner's budget.
   */
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
});
export type WorktreeDto = z.infer<typeof WorktreeDtoSchema>;

export const WorktreesQuerySchema = z.object({
  /** Measure each folder's disk space (cached by the runner). */
  sizes: QueryBooleanSchema.optional(),
});

export const WorktreesResponseSchema = z.object({ worktrees: z.array(WorktreeDtoSchema) });

/**
 * Removal of a project's primary clone and of its worktrees (T8 « Supprimer aussi le clone de
 * VPS-3 »). Refused while a session or a command runs, or when work exists only on the server
 * (uncommitted files, commits pushed nowhere): nothing is deleted then.
 */
export const RemoveCloneResultSchema = z.object({
  operationId: UuidSchema.nullable(),
  removed: z.boolean(),
  /** Space freed (measured before the removal), null when it could not be measured. */
  freedBytes: z.number().int().nonnegative().nullable(),
  /** Worktree folders removed with the clone. */
  worktrees: z.number().int().nonnegative(),
});
export type RemoveCloneResult = z.infer<typeof RemoveCloneResultSchema>;

export const CreateWorktreeRequestSchema = z.object({
  name: WorktreeNameSchema.optional(),
  /** Branch of the worktree. Created from `base` when it does not exist. */
  branch: BranchNameSchema,
  base: BranchNameSchema.optional(),
  actorUserId: z.string().nullish(),
});
export const RemoveWorktreeQuerySchema = z.object({
  force: z
    .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
    .optional()
    .transform((v) => v === true || v === '1' || v === 'true'),
  /** Also delete the local branch when it is merged (never an unmerged one). */
  deleteBranch: z
    .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
    .optional()
    .transform((v) => v === true || v === '1' || v === 'true'),
});
export const RemoveWorktreeResultSchema = z.object({
  operationId: UuidSchema.nullable(),
  removed: z.boolean(),
  branchDeleted: z.boolean(),
});

// ---------------------------------------------------------------------------------------------
// Changes, diff, stage, commit, push
// ---------------------------------------------------------------------------------------------

export const CHANGE_LETTERS = ['M', 'A', 'D', 'R', 'C', 'T', 'U', '?'] as const;
export const ChangedFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  /** M modifié · A ajouté · D supprimé · R renommé · C copié · T type changé · U conflit · ? non suivi (shown as A). */
  status: z.enum(CHANGE_LETTERS),
  staged: z.boolean(),
  unstaged: z.boolean(),
  insertions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
  /**
   * `false`: the lines of this untracked file were not counted (file too large, unreadable, or the
   * read budget of a huge untracked tree was spent) — `insertions` is then 0, not a measure.
   */
  linesCounted: z.boolean().optional(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const ChangesQuerySchema = z.object({
  /**
   * `head` (default): working tree + index vs HEAD (what a commit would contain, Figma Q10).
   * `merge-base`: everything on the branch vs the merge-base with `base`.
   */
  against: z.enum(['head', 'merge-base']).default('head'),
  base: z.string().trim().min(1).max(200).optional(),
});
export const ChangesResponseSchema = z.object({
  branch: z.string().nullable(),
  base: z.string().nullable(),
  files: z.array(ChangedFileSchema),
  totals: z.object({ files: z.number().int(), insertions: z.number().int(), deletions: z.number().int() }),
});
export type ChangesResponse = z.infer<typeof ChangesResponseSchema>;

export const DiffLineSchema = z.object({
  type: z.enum(['context', 'add', 'del']),
  oldNumber: z.number().int().nullable(),
  newNumber: z.number().int().nullable(),
  text: z.string(),
  /** `\ No newline at end of file` follows this line. */
  noNewline: z.boolean().optional(),
});
export const DiffHunkSchema = z.object({
  header: z.string(),
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  /** Text after the second `@@` (function context). */
  context: z.string(),
  lines: z.array(DiffLineSchema),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const FileDiffSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(CHANGE_LETTERS),
  binary: z.boolean(),
  /** Output larger than the cap: hunks are cut, `truncated` is true. */
  truncated: z.boolean(),
  tooLarge: z.boolean(),
  insertions: z.number().int(),
  deletions: z.number().int(),
  baseLabel: z.string(),
  headLabel: z.string(),
  hunks: z.array(DiffHunkSchema),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

export const DiffQuerySchema = z.object({
  path: RelativePathSchema.refine((value) => value.length > 0, { message: 'Chemin requis.' }),
  against: z.enum(['head', 'merge-base', 'staged']).default('head'),
  base: z.string().trim().min(1).max(200).optional(),
  context: z.coerce.number().int().min(0).max(50).default(3),
});

export const PathsRequestSchema = z.object({ paths: z.array(RelativePathSchema).min(1).max(2000) });
export const StageResultSchema = z.object({ status: GitStatusSchema });

export const CommitRequestSchema = z.object({
  /** Subject line. */
  message: z.string().trim().min(1).max(500),
  body: z.string().max(20_000).optional(),
  author: GitIdentitySchema,
  /** Commit exactly these paths (staged first). Absent = what is already staged. */
  paths: z.array(RelativePathSchema).max(2000).optional(),
  /** Run the repository's own hooks (pre-commit…). Off by default: runner-initiated git ignores repo hooks. */
  runHooks: z.boolean().default(false),
  sessionId: UuidSchema.optional(),
  actorUserId: z.string().nullish(),
});
export const CommitResultSchema = z.object({
  operationId: UuidSchema.nullable(),
  sha: z.string(),
  shortSha: z.string(),
  branch: z.string().nullable(),
  filesCommitted: z.number().int(),
  insertions: z.number().int(),
  deletions: z.number().int(),
});
export type CommitResult = z.infer<typeof CommitResultSchema>;

export const PushRequestSchema = z.object({
  /** Write token header for github.com (from `getGitAuthForRepo(fullName, 'write')`). */
  extraHeader: GitExtraHeaderSchema,
  /** Remote branch name (default: same as the local branch). */
  remoteBranch: BranchNameSchema.optional(),
  setUpstream: z.boolean().default(true),
  /** Protected branches the push must refuse (project settings). */
  protectedBranches: z.array(z.string()).max(50).default([]),
  sessionId: UuidSchema.optional(),
  actorUserId: z.string().nullish(),
});
export const PushResultSchema = z.object({
  operationId: UuidSchema.nullable(),
  branch: z.string(),
  remoteBranch: z.string(),
  headSha: z.string(),
  upToDate: z.boolean(),
  createdRemoteBranch: z.boolean(),
});
export type PushResult = z.infer<typeof PushResultSchema>;

export const AheadBehindQuerySchema = z.object({ base: z.string().trim().min(1).max(200).optional() });
export const AheadBehindSchema = z.object({
  branch: z.string().nullable(),
  base: z.string(),
  ahead: z.number().int(),
  behind: z.number().int(),
  /** `origin/<branch>` comparison when an upstream exists. */
  upstream: z.object({ name: z.string(), ahead: z.number().int(), behind: z.number().int() }).nullable(),
  dirtyFiles: z.number().int(),
});
export type AheadBehind = z.infer<typeof AheadBehindSchema>;

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export const TreeQuerySchema = z.object({ path: RelativePathSchema.default('') });
export const TreeEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['dir', 'file', 'symlink', 'other']),
  size: z.number().nullable(),
  ignored: z.boolean(),
  /** Line count for small text files where the UI shows it (CLAUDE.md « 212 lignes »). */
  lines: z.number().int().nullable(),
});
export type TreeEntry = z.infer<typeof TreeEntrySchema>;
export const TreeResponseSchema = z.object({ path: z.string(), entries: z.array(TreeEntrySchema), truncated: z.boolean() });

export const FileQuerySchema = z.object({ path: RelativePathSchema.refine((v) => v.length > 0, { message: 'Chemin requis.' }) });
export const FileContentSchema = z.object({
  path: z.string(),
  size: z.number(),
  binary: z.boolean(),
  truncated: z.boolean(),
  /** UTF-8 text (null for binary files or files above the cap). */
  content: z.string().nullable(),
  language: z.string().nullable(),
  lines: z.number().int().nullable(),
  modifiedAt: IsoDateSchema.nullable(),
});
export type FileContent = z.infer<typeof FileContentSchema>;

export const ClaudeMdQuerySchema = z.object({ worktreeId: UuidSchema.optional() });
export const ClaudeMdSchema = z.object({
  worktreeId: UuidSchema,
  exists: z.boolean(),
  content: z.string().nullable(),
  lines: z.number().int().nullable(),
  size: z.number().nullable(),
  modifiedAt: IsoDateSchema.nullable(),
  lastCommit: z.object({ sha: z.string(), committedAt: IsoDateSchema, subject: z.string() }).nullable(),
});
export const WriteClaudeMdRequestSchema = z.object({
  content: z.string().max(512 * 1024),
  worktreeId: UuidSchema.optional(),
  commit: z.object({ message: z.string().trim().min(1).max(500), author: GitIdentitySchema }).optional(),
  actorUserId: z.string().nullish(),
});
export const WriteClaudeMdResultSchema = z.object({
  operationId: UuidSchema.nullable(),
  lines: z.number().int(),
  commitSha: z.string().nullable(),
});

export const ProjectRefSchema = z.object({ projectId: UuidSchema });
export const WorktreeRefSchema = z.object({ worktreeId: UuidSchema });
