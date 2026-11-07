/**
 * Data shapes of the Projets domain (D02/M02 list, D03/A1–A4 add flow, D04/M04 detail), shared by
 * the server module, the route handlers and the client components (type-only imports).
 * Dates are ISO strings: everything crosses the server → client boundary as JSON.
 */
import type {
  CommandKind,
  CommandRunStatus,
  ProjectCommands,
  ProjectOptions,
  ProjectStatus,
  SessionStatus,
  SyncState,
} from '@nuera/db';
import type { McpStatus } from '@nuera/db';

export type { CommandKind, CommandRunStatus, ProjectCommands, ProjectOptions, ProjectStatus, SyncState };

/** D02 chips: « Tous », « Favoris », « Archivés » (`?filtre=`). */
export const PROJECT_FILTERS = ['tous', 'favoris', 'archives'] as const;
export type ProjectFilter = (typeof PROJECT_FILTERS)[number];

/** D02 sort select (`?tri=`): only « activité récente » is drawn; the others are sober additions. */
export const PROJECT_SORTS = ['activite', 'nom', 'ajout'] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number];

/** Commands the D04 environment tile shows, in the Figma order (Lint is an addition). */
export const PROJECT_COMMAND_KINDS = ['install', 'dev', 'build', 'test', 'lint'] as const satisfies readonly CommandKind[];
export type ProjectCommandKind = (typeof PROJECT_COMMAND_KINDS)[number];

export interface ProjectSyncView {
  state: SyncState;
  ahead: number;
  behind: number;
  /** A fetch / pull is running (« Synchronisation… »). */
  syncing: boolean;
  /** The last pull stopped on a conflict that has not been fixed since (« Conflit à résoudre »). */
  conflict: boolean;
}

export interface ProjectSessionCounts {
  /** Live CLI (running, waiting for a permission or an instruction). */
  active: number;
  interrupted: number;
  finished: number;
  /** Every non-archived session of the project. */
  total: number;
}

/** Operation in flight on a project (clone A2, fetch/pull). */
export interface ProjectOperationView {
  id: string;
  kind: string;
  status: string;
  progress: number | null;
  title: string | null;
}

export interface ProjectListItem {
  id: string;
  slug: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  path: string;
  status: ProjectStatus;
  /** Last error / note written by the runner (failed clone, failed scheduled fetch…). */
  statusDetail: string | null;
  favorite: boolean;
  archivedAt: string | null;
  branch: string | null;
  defaultBranch: string;
  sync: ProjectSyncView;
  sessions: ProjectSessionCounts;
  lastActivityAt: string | null;
  createdAt: string;
  operation: ProjectOperationView | null;
}

export interface DiskUsage {
  usedBytes: number;
  totalBytes: number;
  freeBytes: number;
}

/** Server (runner instance) of the space, as the pages name it (« VPS-3 » for the default one). */
export interface ProjectServerRef {
  id: string;
  name: string;
}

export interface ProjectListResult {
  items: ProjectListItem[];
  /** Chip counters of the space (never another space's projects). */
  counts: { all: number; favorites: number; archived: number };
  /** File system of the projects root (runner), null when the runner does not answer. */
  disk: DiskUsage | null;
  runnerAvailable: boolean;
  /** Server of the space (where new projects are cloned); null while none is assigned. */
  environment: ProjectServerRef | null;
}

/** One independently loaded part of the detail page: a failure never breaks the others. */
export type Part<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; /** The runner of the project's server does not answer. */ unavailable: boolean };

export interface BranchView {
  name: string;
  kind: 'local' | 'remote';
  current: boolean;
  protected: boolean;
  merged: boolean;
  isDefault: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  committedAt: string | null;
  subject: string;
  worktreeId: string | null;
  worktreeName: string | null;
  sessionId: string | null;
}

export interface BranchesView {
  defaultBranch: string;
  /** Local branches first (current, then by date), then the remote-only ones. */
  items: BranchView[];
}

export interface WorktreeView {
  id: string;
  name: string;
  branch: string;
  baseBranch: string | null;
  path: string;
  isPrimary: boolean;
  status: string;
  createdAt: string;
  lastUsedAt: string | null;
  dirtyFiles: number | null;
  ahead: number | null;
  behind: number | null;
  liveSessionId: string | null;
}

export interface RunView {
  id: string;
  kind: CommandKind;
  command: string;
  status: CommandRunStatus;
  exitCode: number | null;
  port: number | null;
  summary: string | null;
  worktreeId: string | null;
  worktreeName: string | null;
  /** Dev server name (« client ») of a `dev` run; null otherwise. */
  name?: string | null;
  startedAt: string;
  finishedAt: string | null;
  tests: { passed: number; failed: number; skipped: number; total: number } | null;
}

export interface ClaudeMdView {
  worktreeId: string;
  exists: boolean;
  content: string | null;
  lines: number | null;
  modifiedAt: string | null;
  lastCommit: { sha: string; committedAt: string; subject: string } | null;
}

export interface ProjectMcpToolView {
  id: string;
  name: string;
  label: string;
  line: string | null;
  enabled: boolean;
  status: McpStatus;
  needsReconnect: boolean;
  /** Where the owner fixes a degraded server (Intégrations). */
  reconnectHref: string;
}

export interface EnvVarView {
  id: string;
  key: string;
  secret: boolean;
  /** Plain value of a NON-secret variable only. Secret values never leave the server. */
  value: string | null;
  updatedAt: string;
}

export interface ProjectSessionView {
  id: string;
  title: string;
  status: SessionStatus;
  branch: string | null;
  worktreeName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  pendingPermissionId: string | null;
  resumable: boolean;
}

export interface ProjectDetail {
  project: ProjectListItem & {
    commands: ProjectCommands;
    options: ProjectOptions;
    lastSyncedAt: string | null;
    lastFetchedAt: string | null;
    claudeMdUpdatedAt: string | null;
    claudeMdCommitSha: string | null;
    primaryWorktreeId: string | null;
    isPrivate: boolean;
    primaryLanguage: string | null;
  };
  /** Server holding the project (immutable): its name is the one of the page's copy. */
  environment: ProjectServerRef;
  runnerAvailable: boolean;
  branches: Part<BranchesView>;
  worktrees: Part<WorktreeView[]>;
  /** Primary clone working tree (uncommitted files, conflicts). */
  status: Part<{ dirtyFiles: number; conflicted: number; branch: string | null }>;
  claudeMd: Part<ClaudeMdView>;
  runs: { latest: Partial<Record<CommandKind, RunView>>; recent: RunView[] };
  mcp: Part<ProjectMcpToolView[]>;
  env: EnvVarView[];
  sessions: { items: ProjectSessionView[]; counts: ProjectSessionCounts; liveSessionId: string | null };
  counts: { branches: number | null; mcpEnabled: number | null; env: number; sessions: number };
}

// ---------------------------------------------------------------------------------------------
// Add flow (A1 → D03 → A2/A3/A4)
// ---------------------------------------------------------------------------------------------

export interface AddRepoItem {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  language: string | null;
  pushedAt: string | null;
  defaultBranch: string;
  archived: boolean;
  /** Project of THIS space already tracking this repository (« Déjà cloné »). */
  clonedProject: { id: string; name: string } | null;
  /** GitHub source listing it first (the one used when the owner does not choose); null = fallback token. */
  sourceId: string | null;
  /**
   * Every GitHub source of the space that reaches this repository (same repository id), first
   * one first. More than one = the « Source GitHub » selector of D03.
   */
  sources: AddRepoSource[];
}

export interface AddRepoSource {
  id: string;
  /** Label of the source (« nuera-studio », « Application de Camille »…). */
  label: string;
}

/** A1 account chip: one GitHub account (installation) reached through one source. */
export interface AddRepoAccount {
  /** `<sourceId>:<login>` (chip value). */
  key: string;
  login: string;
  count: number;
  manageUrl: string | null;
  /** Empty for the repositories of the fallback token (no source). */
  sourceId: string;
  sourceLabel: string;
}

export type AddReposResult =
  | {
      connected: true;
      total: number;
      /** GitHub sources of the space that listed repositories. */
      sources: AddRepoSource[];
      accounts: AddRepoAccount[];
      repos: AddRepoItem[];
      /** « gérer l'accès sur GitHub »: only when the space has a single source. */
      manageAccessUrl: string | null;
      /** Sources that could not be listed (their repositories are missing from `repos`). */
      failures: Array<{ label: string; message: string }>;
    }
  | {
      connected: false;
      /** GitHub not connected / app not installed (T7-style call to action towards Intégrations). */
      message: string;
      detail: string | null;
    };

export interface RepoPreview {
  fullName: string;
  /** GitHub source the preview was read with (the one bound to the project at creation). */
  sourceId: string | null;
  private: boolean;
  language: string | null;
  pushedAt: string | null;
  defaultBranch: string;
  /** Repository size in bytes when GitHub reports it. */
  sizeBytes: number | null;
  branches: string[];
  /** Root inspection through the GitHub contents API; null when it could not be read. */
  inspection: {
    claudeMd: boolean;
    packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
    lockfile: string | null;
    commands: ProjectCommands;
  } | null;
  /** Default destination proposed by the runner (`<projects root>/<repo>`), with its check. */
  destination: DestinationView | null;
  disk: DiskUsage | null;
}

export interface DestinationView {
  path: string;
  available: boolean;
  exists: boolean;
  empty: boolean;
  fileCount: number;
  suggestedPath: string | null;
  existingClone: { fullName: string | null; branch: string | null; sameRepository: boolean } | null;
  /** Nuera project registered at that path (active or archived), for « Ouvrir le projet existant ». */
  existingProject: { id: string; name: string; archived: boolean } | null;
}

export interface CreateProjectResult {
  projectId: string;
  operationId: string;
}

/** Error body of the project routes: AppError fields + the runner's machine reason and safe data. */
export interface ProjectErrorBody {
  error: {
    code: string;
    message: string;
    detail?: string;
    raw?: string;
    untouched?: string;
    reason?: string;
    data?: Record<string, unknown>;
  };
}

export interface WorktreeRemovalPreview {
  worktree: WorktreeView;
  /** Files that would be lost (uncommitted), first 50. */
  dirtyFiles: string[];
  canRemove: boolean;
  blockedReason: string | null;
}

/** T8 « Archiver … ? » consequences. */
export interface ArchivePreviewView {
  /** Ended sessions archived with the project (« 1 session terminée sera archivée avec lui »). */
  endedSessions: number;
  /** Live sessions block the archive (stop them first). */
  liveSessions: number;
  /**
   * T8 option « Supprimer aussi le clone de VPS-3 (2,1 Go) »: whether a clone exists on the server
   * (null = the runner did not answer, the option is then unavailable) and its disk space with its
   * worktrees (null = not measured).
   */
  clone: { onDisk: boolean | null; sizeBytes: number | null };
}

/** Result of « Archiver » (the optional clone removal runs after the archive itself). */
export interface ArchiveResultView {
  archivedSessions: number;
  /** null = not asked. */
  clone: { removed: true; freedBytes: number | null } | { removed: false; message: string; untouched: string | null } | null;
}
