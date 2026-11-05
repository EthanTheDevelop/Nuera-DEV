/**
 * Data contract of Paramètres (D08 / M08) between the server module `@/server/preferences` and the
 * client components. Serializable only (dates as ISO strings): it crosses the RSC boundary.
 * Every value comes from the database, the runner, the auth layer or the Claude CLI — never invented.
 */
import type { PermissionMode } from '@nuera/db/schema';

export type ThemeValue = 'light' | 'dark' | 'system';

/** Section of the page loaded on its own: a failure stays inline (T4), the rest of the page renders. */
export type Load<T> = { ok: true; data: T } | { ok: false; error: LoadError };

export interface LoadError {
  message: string;
  detail?: string;
  raw?: string;
  /** The runner did not answer (T5 is shown by the shell; the page shows a sober inline state). */
  unavailable?: boolean;
}

/** Fields of `app_settings` this page reads and edits (the projects root is read from the runner). */
export interface SettingsValues {
  maxConcurrentSessions: number;
  defaultModel: string | null;
  defaultEffort: string | null;
  defaultPermissionMode: PermissionMode;
  blockBypassPermissions: boolean;
  permissionWaitSeconds: number;
  remoteControlByDefault: boolean;
  webSessionIdleHours: number;
  webSessionMaxDays: number;
  serverName: string;
  serverLocation: string | null;
  sessionMemoryLimitMb: number | null;
  worktreeStaleDays: number;
  theme: ThemeValue;
  locale: string;
  updatedAt: string;
}

/** `claude auth status --json` + `claude --version`, as the runner reports them (whitelisted fields). */
export interface ClaudeCliView {
  checkedAt: string;
  state: 'connected' | 'disconnected' | 'wrong_method' | 'not_installed' | 'error';
  installed: boolean;
  version: string | null;
  loggedIn: boolean | null;
  /** Raw CLI value: `claude.ai`, `api_key`, `oauth_token`… */
  authMethod: string | null;
  /** Raw CLI value (`max`, `pro`…) or null when the CLI does not print it. */
  subscriptionType: string | null;
  loginExpiresAt: string | null;
  error: string | null;
}

/** A model seen in the CLI's own status line of a past session (`sessions.cli_status.model`). */
export interface SeenModel {
  id: string;
  displayName: string | null;
}

export interface WebSessionView {
  id: string;
  deviceLabel: string;
  deviceKind: 'desktop' | 'phone' | 'tablet' | 'unknown';
  /** City (trusted proxy header at sign-in), else IP, else null. */
  location: string | null;
  current: boolean;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
}

export interface PasskeyView {
  id: string;
  name: string | null;
  provider: string | null;
  createdAt: string | null;
  deviceType: string;
  backedUp: boolean;
}

export interface AccountView {
  twoFactor: { enabled: boolean; backupCodesRemaining: number | null };
  passkeys: PasskeyView[];
  sessions: WebSessionView[];
}

export interface JournalEntry {
  id: number;
  at: string;
  summary: string;
  action: string;
}

export interface JournalPage {
  items: JournalEntry[];
  nextCursor: number | null;
}

export interface ToolView {
  available: boolean;
  version: string | null;
  error: string | null;
}

/** Runner `GET /v1/health`. */
export interface RunnerHealthView {
  ok: boolean;
  version: string;
  startedAt: string;
  backend: 'tmux' | 'pty';
  git: ToolView;
  tmux: ToolView;
  claude: ToolView;
  database: { ok: boolean; error: string | null };
  disk: { path: string; freeBytes: number; totalBytes: number } | null;
  projectsRoot: string;
}

/** Live Claude processes (runner `listSessions`, `live`). */
export interface LiveSessionsView {
  count: number;
  /** Worktree names (« crm-core, devis-pdf »). */
  names: string[];
}

export interface UptimeDayView {
  day: string;
  /** 0–100, null when nothing was measured. */
  availability: number | null;
  incidents: Array<{ start: string; end: string | null; reason: string }>;
}

export interface UptimeView {
  days: UptimeDayView[];
  availabilityPercent: number | null;
}

/** The web process itself (the page is being served, so it is up). */
export interface WebProcessView {
  startedAt: string;
}

export interface MetricsView {
  sampledAt: string;
  cpuPercent: number;
  cpuCount: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  sessionsLive: number;
  terminalsLive: number;
  runsLive: number;
}

export interface StaleWorktree {
  id: string;
  name: string;
  branch: string;
  projectId: string;
  projectName: string;
  /** Last session activity in the worktree, else its last use, else its creation. */
  lastActivityAt: string;
  /** Uncommitted files (null when git could not be read). */
  dirtyFiles: number | null;
  /** Eligible = no live session and no uncommitted change (excluded d'office otherwise). */
  eligible: boolean;
  excludedReason: string | null;
  /** Disk space measured by the runner (like `du -s`); null = not measured. */
  sizeBytes: number | null;
}

export interface StaleWorktreesView {
  staleDays: number;
  items: StaleWorktree[];
  /** Projects whose worktrees could not be read (runner error), by name. */
  unreadable: string[];
}

export interface RemoveWorktreesResult {
  removed: Array<{ id: string; name: string }>;
  skipped: Array<{ id: string; name: string; reason: string }>;
}

export interface OperationLogItem {
  id: string;
  kind: string;
  status: string;
  title: string | null;
  projectName: string | null;
  createdAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  hasLog: boolean;
}

export interface SessionLogItem {
  id: string;
  title: string;
  status: string;
  projectName: string | null;
  branch: string | null;
  endedAt: string | null;
  lastActivityAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PushDeviceView {
  id: string;
  deviceLabel: string | null;
  service: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PushView {
  enabled: boolean;
  publicKey: string | null;
  reason: string | null;
  devices: PushDeviceView[];
}

/** Sections of the page that follow the session statuses (`loadLiveStatusAction`). */
export interface LiveStatusView {
  liveSessions: Load<LiveSessionsView>;
  worktrees: Load<StaleWorktreesView>;
}

export interface SettingsPageData {
  /** Server time of the snapshot (relative times rendered identically on SSR and hydration). */
  now: string;
  owner: { name: string; email: string };
  settings: SettingsValues;
  claude: Load<ClaudeCliView>;
  seenModels: SeenModel[];
  account: Load<AccountView>;
  journal: Load<JournalPage>;
  health: Load<RunnerHealthView>;
  liveSessions: Load<LiveSessionsView>;
  uptime: Load<UptimeView>;
  metrics: Load<MetricsView>;
  web: WebProcessView;
  worktrees: Load<StaleWorktreesView>;
  push: Load<PushView>;
}
