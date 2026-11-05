/**
 * Accueil (D01 desktop · M01 phone) — data contract between `@/server/home` (`getHomeData`) and the
 * client view. Serializable only: it crosses the RSC boundary. Every value comes from the database,
 * the runner, GitHub (pull requests stored by Nuera Dev) or the Claude CLI; a part that could not be
 * read carries `error` instead of an invented value.
 */
import type { PermissionMode, SessionStatus, SyncState } from '@nuera/db';
import type { ClaudeState, ServerAvailability } from '@/components/shell/types';

export type { ClaudeState, ServerAvailability, SessionStatus };

/** Why a part of the page could not be read (the rest of the page renders normally). */
export type HomePartError = 'runner_unavailable' | 'failed';

export interface HomeServerMetrics {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  sampledAt: string;
}

/** `Tuile · Serveur VPS-3` (D01) · status pill « VPS-3 en ligne » (M01). */
export interface HomeServer {
  /** app_settings.serverName (« VPS-3 »). */
  name: string;
  /** app_settings.serverLocation (« OVH Gravelines »), null when not set. */
  location: string | null;
  availability: ServerAvailability;
  metrics: HomeServerMetrics | null;
  /** Host uptime in seconds (« en ligne depuis 18 j »), null when the runner did not answer. */
  uptimeSec: number | null;
  /** Last proof of life of the runner (ISO). */
  lastContactAt: string | null;
}

/** `Tuile · Claude Code` (D01) — only what `claude auth status` exposes, never guessed. */
export interface HomeClaude {
  state: ClaudeState;
  /** Plan reported by the CLI (`subscriptionType`: « max », « pro »…), null when it does not say. */
  plan: string | null;
  /** app_settings.defaultModel; null = « défaut du CLI ». */
  defaultModel: string | null;
  checkedAt: string | null;
}

export interface HomePendingPermission {
  id: string;
  sessionId: string;
  sessionTitle: string;
  projectName: string;
  /** Command / path / target shown in the request (« npm run test -- e2e »), verbatim. */
  target: string | null;
  /** Bash request: the target is a shell command (rendered `$ …`). */
  isCommand: boolean;
  /** « Claude demande à exécuter une commande ». */
  title: string;
  createdAt: string;
}

/** A session as the Accueil shows it (cards, rail, quick resume). */
export interface HomeSession {
  id: string;
  title: string;
  status: SessionStatus;
  live: boolean;
  resumable: boolean;
  projectId: string;
  projectName: string;
  branch: string | null;
  worktreeName: string | null;
  permissionMode: PermissionMode;
  currentActivity: string | null;
  lastInstruction: string | null;
  planDone: number | null;
  planTotal: number | null;
  createdAt: string;
  startedAt: string | null;
  lastActivityAt: string | null;
  /** Pending permission request of this session (oldest first), with its target. */
  pendingPermission: HomePendingPermission | null;
}

export interface HomeSessions {
  /** Active sessions (new / running / waiting_permission / waiting_input), most urgent first. */
  items: HomeSession[];
  /** False when the runner could not confirm which CLI is alive (database view). */
  verified: boolean;
  error: HomePartError | null;
}

export interface HomeCapacity {
  /** Live sessions counted by the runner (database fallback). */
  active: number;
  /** app_settings.maxConcurrentSessions. */
  max: number;
}

export interface HomeProjectSync {
  state: SyncState;
  ahead: number;
  behind: number;
  /** Clone or synchronisation running (« Synchronisation… »). */
  syncing: boolean;
}

/** `Tuile · Projets récents` row. */
export interface HomeProject {
  id: string;
  name: string;
  fullName: string;
  branch: string | null;
  sync: HomeProjectSync;
  favorite: boolean;
  lastActivityAt: string | null;
}

export interface HomeProjects {
  /** Up to 4 non-archived projects, most recent activity first. */
  items: HomeProject[];
  /** Non-archived projects (0 = first run, Flow A entry). */
  total: number;
}

/** `Tuile · Dernières modifications` row (commit of a recent project, or a pull request opened by Nuera Dev). */
export interface HomeGitEvent {
  id: string;
  kind: 'commit' | 'pull_request';
  sha: string | null;
  number: number | null;
  message: string;
  projectId: string;
  projectName: string;
  branch: string | null;
  /** « par Claude Code »: the commit was made from a Nuera Dev session (operations.session_id). */
  byClaude: boolean;
  at: string;
  /** Commit / pull request page on GitHub. */
  href: string | null;
}

export interface HomeActivity {
  /** Most recent first, at most 6 (desktop shows 4, phone 2 commits). */
  items: HomeGitEvent[];
  /** « Ouvrir sur GitHub »: repository of the most recent row. */
  githubUrl: string | null;
  /** Some project histories could not be read (runner down, git error). */
  incomplete: boolean;
  error: HomePartError | null;
}

export interface HomeIntegrationRow {
  /** 'github' | `mcp:<name>` */
  id: string;
  name: string;
  /** Icon name of `@/components/icons` (github, figma, rocket, plug…). */
  icon: string;
  detail: string | null;
  badge: { label: string; tone: 'accent' | 'success' | 'warn' | 'danger' | 'neutral' };
  href: string;
}

/** `Tuile · Intégrations` (D01 only). */
export interface HomeIntegrations {
  rows: HomeIntegrationRow[];
  /** « Coolify : reconnecter pour relancer les déploiements de développement. » */
  footer: { text: string; href: string } | null;
  attentionCount: number;
  /** MCP servers registered but enabled in no project (not listed as rows). */
  inactiveMcp: number;
}

export interface HomeData {
  /** Server time of the snapshot (ISO): relative times are computed from it on the first render. */
  generatedAt: string;
  /** « Bonjour {prénom} ». */
  firstName: string;
  server: HomeServer;
  claude: HomeClaude;
  capacity: HomeCapacity;
  sessions: HomeSessions;
  /** Pending permission requests of active sessions, oldest first. */
  pending: HomePendingPermission[];
  /** `Tuile · Reprise rapide`: last active session, else the last resumable one. */
  quickResume: HomeSession | null;
  projects: HomeProjects;
  activity: HomeActivity;
  /** null when the integrations could not be read (tile shows its own error). */
  integrations: HomeIntegrations | null;
}
