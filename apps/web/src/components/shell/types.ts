/**
 * Data contract between the shell layouts (server: `getShellData`) and the shell client components.
 * Serializable only (strings, numbers, booleans, arrays) — it crosses the RSC boundary.
 */

/** `available` = the runner answered; `unavailable` = RUNNER_UNAVAILABLE (Figma T5); `unknown` = not checked yet. */
export type ServerAvailability = 'available' | 'unavailable' | 'unknown';

/** Claude CLI state as reported by `claude auth status` through the runner — never guessed. */
export type ClaudeState = 'connected' | 'disconnected' | 'wrong_method' | 'not_installed' | 'error' | 'unknown';

export interface ShellMetrics {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  sampledAt: string;
}

export interface ShellServer {
  /** app_settings.serverName (« VPS-3 »). */
  name: string;
  /** app_settings.serverLocation (« OVH Gravelines »), null when not set. */
  location: string | null;
  /** Provider status page (env NUERA_SERVER_STATUS_URL), null when not configured. */
  statusUrl: string | null;
  availability: ServerAvailability;
  metrics: ShellMetrics | null;
  /** Last proof of life of the runner (metrics sample or uptime heartbeat), ISO. */
  lastContactAt: string | null;
}

export interface ShellClaude {
  state: ClaudeState;
  version: string | null;
  checkedAt: string | null;
  error: string | null;
}

export interface ShellNotification {
  id: string;
  kind: string;
  severity: 'info' | 'success' | 'warning' | 'danger';
  title: string;
  body: string | null;
  href: string | null;
  read: boolean;
  createdAt: string;
}

export interface ShellUser {
  name: string;
  /** First word of the name (« Bonjour Nezar »). */
  firstName: string;
  twoFactorEnabled: boolean;
}

export interface ShellData {
  user: ShellUser;
  server: ShellServer;
  claude: ShellClaude;
  sessions: {
    /** Ids of sessions in new / running / waiting_permission / waiting_input (not archived). */
    activeIds: string[];
    /** app_settings.maxConcurrentSessions. */
    max: number;
  };
  notifications: { items: ShellNotification[]; unread: number };
  /** Server time of the snapshot (ISO), for relative times rendered on the client. */
  generatedAt: string;
}

/** Session statuses counted as « actives » (Sessions bubble, « SESSIONS ACTIVES · N »). */
export const ACTIVE_SESSION_STATUSES = ['new', 'running', 'waiting_permission', 'waiting_input'] as const;
