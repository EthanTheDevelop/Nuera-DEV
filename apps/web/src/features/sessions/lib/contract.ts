/**
 * Sessions lot — contracts shared by the browser (dialog, page) and the server module
 * (`@/server/sessions`, API routes). Pure: Zod schemas, types and URL helpers, no I/O.
 */
import { isValidBranchName } from '@nuera/shared/paths';
import { z } from 'zod';
import type { PermissionMode, SessionStatus } from '@nuera/db/schema';
import type { UsageLimit } from '@nuera/shared/runner';

export type { PermissionMode, SessionStatus };

export const PERMISSION_MODE_VALUES = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const satisfies readonly PermissionMode[];

/** Statuses during which the session is « en cours » (D06 « EN COURS · n », sidebar bubble). */
export const ACTIVE_STATUSES = ['new', 'running', 'waiting_permission', 'waiting_input'] as const satisfies readonly SessionStatus[];
/** A CLI process is expected to be alive (counts in « Capacité »). */
export const LIVE_STATUSES = ['running', 'waiting_permission', 'waiting_input'] as const satisfies readonly SessionStatus[];
/** History = everything that no longer runs. */
export const HISTORY_STATUSES = ['stopped', 'interrupted', 'failed', 'finished', 'archived'] as const satisfies readonly SessionStatus[];

export function isActiveStatus(status: SessionStatus): boolean {
  return (ACTIVE_STATUSES as readonly SessionStatus[]).includes(status);
}
export function isLiveStatus(status: SessionStatus): boolean {
  return (LIVE_STATUSES as readonly SessionStatus[]).includes(status);
}

/**
 * Body of POST /api/sessions/[sessionId]/auto-resume: « Reprise automatique après la limite
 * d'utilisation » for this session (`enabled`: true / false, null = the space default), or
 * « Reprendre maintenant » (`resumeNow`) while the limit stops it.
 */
export const autoResumeInputSchema = z.union([
  z.object({ enabled: z.boolean('valeur oui/non attendue').nullable() }).strict(),
  z.object({ resumeNow: z.literal(true) }).strict(),
]);
export type AutoResumeInput = z.infer<typeof autoResumeInputSchema>;

export const SESSION_TITLE_MAX = 200;
export const INSTRUCTION_MAX = 100_000;
export const DEFAULT_SESSION_TITLE = 'Nouvelle session';

const titleSchema = z
  .string()
  .trim()
  .min(1, 'titre requis')
  .max(SESSION_TITLE_MAX, `${SESSION_TITLE_MAX} caractères au maximum`);

export const branchNameSchema = z
  .string()
  .trim()
  .min(1, 'nom de branche requis')
  .max(200, '200 caractères au maximum')
  .refine(isValidBranchName, 'nom de branche invalide (ni espace, ni « .. », ni ~ ^ : ? * [ \\)');

/** Optional CLI option: '' / null → « défaut du CLI ». */
const cliOption = (pattern: RegExp, message: string) =>
  z
    .string()
    .trim()
    .max(80, '80 caractères au maximum')
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .refine((value) => value === null || pattern.test(value), message);

export const modelSchema = cliOption(/^[A-Za-z0-9._:[\]-]{1,80}$/, 'modèle invalide (lettres, chiffres, . _ : - [ ])');
export const effortSchema = cliOption(/^[a-z]{2,16}$/, "niveau d'effort invalide");

/**
 * Where the session works:
 * - `new`: a new branch (created from `base`, default = the project's default branch) in a new worktree;
 * - `existing`: an existing branch — its worktree when one is open, the primary clone when it is
 *   checked out there, otherwise a new worktree on that branch;
 * - `primary`: the project's primary clone, on its current branch.
 */
export const sessionBranchSchema = z.discriminatedUnion(
  'mode',
  [
    z.object({ mode: z.literal('new'), branch: branchNameSchema, base: branchNameSchema.optional() }).strict(),
    z.object({ mode: z.literal('existing'), branch: branchNameSchema }).strict(),
    z.object({ mode: z.literal('primary') }).strict(),
  ],
  { error: 'choix de branche invalide (nouvelle branche, branche existante ou worktree principal)' },
);
export type SessionBranchInput = z.infer<typeof sessionBranchSchema>;
export type BranchMode = SessionBranchInput['mode'];

/** Body of POST /api/sessions (and of the dialog). Omitted options take the defaults of Paramètres. */
export const createSessionInputSchema = z
  .object({
    projectId: z.uuid('projet invalide'),
    title: titleSchema.default(DEFAULT_SESSION_TITLE),
    branch: sessionBranchSchema,
    permissionMode: z.enum(PERMISSION_MODE_VALUES, 'mode de permission inconnu').optional(),
    model: modelSchema.optional(),
    effort: effortSchema.optional(),
    remoteControl: z.boolean().optional(),
    instruction: z
      .string()
      .max(INSTRUCTION_MAX, 'instruction trop longue')
      .optional()
      .transform((value) => (value && value.trim() !== '' ? value : undefined)),
  })
  .strict();
export type CreateSessionInput = z.input<typeof createSessionInputSchema>;
export type CreateSessionData = z.output<typeof createSessionInputSchema>;

export const renameSessionInputSchema = z.object({ title: titleSchema }).strict();

export const sessionIdParamsSchema = z.object({ sessionId: z.uuid('session invalide') });

// ---------------------------------------------------------------------------------------------
// History filters (D06 « Statut », M06 chips) and period (D06 « 30 derniers jours »)
// ---------------------------------------------------------------------------------------------

/** `?filtre=` values (French, linkable). `toutes` is the default and never written in the URL. */
export const HISTORY_FILTERS = ['toutes', 'terminees', 'reprise-possible', 'reprise-impossible', 'archivees'] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number];

export const HISTORY_FILTER_LABELS: Record<HistoryFilter, { select: string; chip: string }> = {
  toutes: { select: 'tous', chip: 'Toutes' },
  terminees: { select: 'terminées', chip: 'Terminées' },
  'reprise-possible': { select: 'reprise possible', chip: 'Reprise possible' },
  'reprise-impossible': { select: 'reprise impossible', chip: 'Reprise impossible' },
  archivees: { select: 'archivées', chip: 'Archivées' },
};

/** M06 chips: `Toutes` · `Terminées` · `Reprise possible` · `Archivées`. */
export const PHONE_HISTORY_FILTERS = ['toutes', 'terminees', 'reprise-possible', 'archivees'] as const satisfies readonly HistoryFilter[];

/** `?periode=` values. Default `30j` (Figma « 30 derniers jours »). */
export const HISTORY_PERIODS = ['7j', '30j', '90j', 'tout'] as const;
export type HistoryPeriod = (typeof HISTORY_PERIODS)[number];
export const DEFAULT_HISTORY_PERIOD: HistoryPeriod = '30j';
export const HISTORY_PERIOD_LABELS: Record<HistoryPeriod, string> = {
  '7j': '7 derniers jours',
  '30j': '30 derniers jours',
  '90j': '90 derniers jours',
  tout: 'Toute la période',
};
export const HISTORY_PERIOD_DAYS: Record<HistoryPeriod, number | null> = { '7j': 7, '30j': 30, '90j': 90, tout: null };

export const HISTORY_PAGE_SIZE = 20;
export const SEARCH_MAX = 120;

/** Query of GET /api/sessions. */
export const listSessionsQuerySchema = z.object({
  statut: z.enum(['active', 'history']).default('history'),
  projet: z.uuid('projet invalide').optional(),
  filtre: z.enum(HISTORY_FILTERS).default('toutes'),
  periode: z.enum(HISTORY_PERIODS).default(DEFAULT_HISTORY_PERIOD),
  q: z.string().trim().max(SEARCH_MAX).optional(),
  curseur: z.string().max(200).optional(),
  limite: z.coerce.number().int().min(1).max(100).optional(),
});

export interface HistoryUrlState {
  filter: HistoryFilter;
  period: HistoryPeriod;
  projectId: string | null;
  q: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SearchParamsLike = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

function readParam(params: SearchParamsLike, name: string): string | null {
  if (typeof (params as { get?: unknown }).get === 'function') return (params as { get(name: string): string | null }).get(name);
  const value = (params as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/** Reads `?filtre=&periode=&projet=&q=` leniently (unknown values fall back to the defaults). */
export function parseHistoryParams(params: SearchParamsLike): HistoryUrlState {
  const filter = readParam(params, 'filtre');
  const period = readParam(params, 'periode');
  const projectId = readParam(params, 'projet');
  const q = (readParam(params, 'q') ?? '').trim().slice(0, SEARCH_MAX);
  return {
    filter: (HISTORY_FILTERS as readonly string[]).includes(filter ?? '') ? (filter as HistoryFilter) : 'toutes',
    period: (HISTORY_PERIODS as readonly string[]).includes(period ?? '') ? (period as HistoryPeriod) : DEFAULT_HISTORY_PERIOD,
    projectId: projectId && UUID_RE.test(projectId) ? projectId : null,
    q,
  };
}

/** Query string of the history state (defaults omitted, stable order). Other params are kept. */
export function historySearch(state: HistoryUrlState, keep?: URLSearchParams): string {
  const params = new URLSearchParams(keep);
  for (const name of ['filtre', 'periode', 'projet', 'q']) params.delete(name);
  if (state.filter !== 'toutes') params.set('filtre', state.filter);
  if (state.period !== DEFAULT_HISTORY_PERIOD) params.set('periode', state.period);
  if (state.projectId) params.set('projet', state.projectId);
  if (state.q) params.set('q', state.q);
  const text = params.toString();
  return text ? `?${text}` : '';
}

// ---------------------------------------------------------------------------------------------
// DTOs (server → browser, serialisable)
// ---------------------------------------------------------------------------------------------

/** Why a stopped session cannot be resumed (« Pourquoi ? »). */
export type ResumeBlockedReason = 'worktree_removed' | 'not_recorded' | 'archived' | 'project_archived';

export interface SessionListItem {
  id: string;
  title: string;
  status: SessionStatus;
  /** A CLI process is attached right now (runner), or the status says so (database fallback). */
  live: boolean;
  /** Worktree present and conversation recorded (« reprise possible »). */
  resumable: boolean;
  resumeBlockedReason: ResumeBlockedReason | null;
  project: { id: string; name: string; slug: string; fullName: string; archived: boolean };
  branch: string | null;
  worktree: { id: string; name: string; isPrimary: boolean; present: boolean } | null;
  permissionMode: PermissionMode;
  model: string | null;
  effort: string | null;
  remoteControl: boolean;
  currentActivity: string | null;
  lastInstruction: string | null;
  pendingPermissionId: string | null;
  errorMessage: string | null;
  planDone: number | null;
  planTotal: number | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  lastActivityAt: string | null;
  archivedAt: string | null;
  /** endedAt − startedAt once ended (null while live or never started). */
  durationMs: number | null;
  /** Stopped on the subscription usage limit and its automatic resumption (runner), null = none. */
  limit: UsageLimit | null;
  /** « Reprise automatique » chosen for this session; null = the space default. */
  autoResume: boolean | null;
}

/** Server (runner instance) of the space, as the session pages show it (« VPS-3 »). */
export interface SessionServer {
  id: string;
  name: string;
}

export interface SessionCapacity {
  /** Live CLI processes (runner), or live statuses in the database when the runner is unreachable. */
  active: number;
  /** Sessions allowed in parallel on the server (`environments.max_concurrent_sessions`); 0 without a server. */
  max: number;
  /** `unassigned`: no server is assigned to the space yet (no session can start). */
  source: 'runner' | 'database' | 'unassigned';
  /** Server of the space (null while none is assigned). */
  environment: SessionServer | null;
}

export interface SessionListPage {
  items: SessionListItem[];
  nextCursor: string | null;
  /** False when the runner was unreachable: `resumable` / `live` come from the database. */
  verified: boolean;
}

export interface SessionSummary {
  session: SessionListItem;
  /** Claude's last message, verbatim (null when none was recorded). */
  finalMessage: string | null;
  /** Bullet lines of the final message, verbatim (« points » of W3). */
  points: string[];
  instructionCount: number;
  /** Commands / edits allowed during the session (permission log). */
  allowedCommands: number;
  /** Uncommitted changes of the worktree (runner), null when unknown. */
  changes: { files: number; additions: number; deletions: number } | null;
}

export interface CreateSessionResult {
  sessionId: string;
  workspaceUrl: string;
  /** First instruction: typed into the CLI, queued until it is ready, or not sent (error kept). */
  instruction: 'none' | 'delivered' | 'queued' | 'failed';
  instructionError: { message: string; detail?: string } | null;
}

/** Options of the « Nouvelle session » dialog (Paramètres defaults, projects, capacity). */
export interface NewSessionProject {
  id: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  currentBranch: string | null;
  worktreePerSession: boolean;
  ready: boolean;
  /** Not ready: « Clonage en cours », « En erreur ». */
  unavailableReason: string | null;
}

export interface NewSessionDefaults {
  permissionMode: PermissionMode;
  model: string | null;
  effort: string | null;
  remoteControl: boolean;
  blockBypassPermissions: boolean;
}

export interface NewSessionOptions {
  projects: NewSessionProject[];
  defaults: NewSessionDefaults;
  capacity: SessionCapacity | null;
  /** The runner did not answer: creation is impossible right now. */
  runnerUnavailable: boolean;
  /** Server of the space where the new session would run (null: none assigned, creation impossible). */
  environment: SessionServer | null;
}

export interface ProjectBranchOption {
  name: string;
  kind: 'local' | 'remote';
  isDefault: boolean;
  protected: boolean;
  /** Checked out in the primary clone. */
  current: boolean;
  worktreeName: string | null;
  /** A live session already works on this branch (cannot be reused). */
  busySessionId: string | null;
}

export interface ProjectBranchOptions {
  projectId: string;
  defaultBranch: string;
  currentBranch: string | null;
  branches: ProjectBranchOption[];
  /** A live session runs in the primary clone. */
  primaryBusy: boolean;
}

export function workspaceUrl(sessionId: string, permissionId?: string | null): string {
  return `/workspace/${sessionId}${permissionId ? `#demande-${permissionId}` : ''}`;
}
