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

/**
 * Live state of the server of the account's space (`environment`). With no server assigned, `name`
 * is empty and nothing else is known: read {@link ShellData.environment} (or `useServerName()`)
 * before showing a server name.
 */
export interface ShellServer {
  /** Name of the server (« VPS-3 » for the default one); empty when no server is assigned. */
  name: string;
  /** Location (« OVH Gravelines »), null when not set. */
  location: string | null;
  /** Provider status page (env NUERA_SERVER_STATUS_URL, default server only), null when not configured. */
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

/** Instance role (docs/MULTICOMPTE.md §2): « Propriétaire » · « Administrateur » · « Membre ». */
export type ShellRole = 'owner' | 'admin' | 'member';

export interface ShellUser {
  /** Account id (multi-tab identity guard: `stream.hello` must name the same account). */
  id: string;
  name: string;
  /** First word of the name (« Bonjour Nezar »). */
  firstName: string;
  role: ShellRole;
  twoFactorEnabled: boolean;
}

/** The account's space (v1: its personal space, never chosen by the client). */
export interface ShellSpace {
  id: string;
  name: string;
}

/** The server (runner instance) of the space; null in ShellData while none is assigned. */
export interface ShellEnvironment {
  id: string;
  /** « VPS-3 » for the default server (Figma copy unchanged). */
  name: string;
  location: string | null;
  /** `active`, or `suspended` while the account is disabled. */
  status: 'pending' | 'active' | 'suspended' | 'retired';
  isDefault: boolean;
}

export interface ShellData {
  user: ShellUser;
  space: ShellSpace;
  /** null: no server assigned to the space yet (« Aucun serveur attribué », never T5). */
  environment: ShellEnvironment | null;
  server: ShellServer;
  claude: ShellClaude;
  sessions: {
    /** Ids of the space's sessions in new / running / waiting_permission / waiting_input (not archived). */
    activeIds: string[];
    /** Sessions parallèles of the server; null without a server. */
    max: number | null;
  };
  notifications: { items: ShellNotification[]; unread: number };
  /** Server time of the snapshot (ISO), for relative times rendered on the client. */
  generatedAt: string;
}

/** Session statuses counted as « actives » (Sessions bubble, « SESSIONS ACTIVES · N »). */
export const ACTIVE_SESSION_STATUSES = ['new', 'running', 'waiting_permission', 'waiting_input'] as const;
