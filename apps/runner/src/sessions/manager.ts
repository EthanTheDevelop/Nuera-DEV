import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import pidusage from 'pidusage';
import { permissionRequests, projects, sessionEvents, sessions, worktrees, type Database } from '@nuera/db';
import {
  CliStatusSchema,
  DEFAULT_AUTO_RESUME_INSTRUCTION,
  LIVE_SESSION_STATUSES,
  PERMISSION_MODES,
  UsageLimitSchema,
  type AutoResumeOptions,
  type CliStatus,
  type PermissionRequestDto,
  type SessionDto,
  type SessionLaunchOptions,
  type UsageLimit,
  type UsageLimitSource,
  type PermissionModeResult,
  type SessionCommandResult,
  type SessionSlashCommandRequest,
  type SwitchablePermissionMode,
  slashCommandText,
} from '@nuera/shared/runner';
import { formatClockDay } from '@nuera/shared/format';
import type { SessionStatusEvent } from '@nuera/shared/events';
import type { Logger } from 'pino';
import type { ClaudeAccount, ClaudeAccounts } from '../claude/accounts';
import { resolveClaudeCommand } from '../claude/bin';
import type { CommonConfigSync } from '../claude/common-config';
import { claudeEnv, gitIdentityEnv } from '../claude/env';
import { getPermissionRow, getProject, getReadyProject, getSessionRow, getWorktree, type WorktreeRow } from '../db/lookups';
import type { EnvironmentScope } from '../environment';
import { GLOBAL, sessionChannel, type EventBus } from '../events/bus';
import { RunnerError } from '../errors';
import type { GitService } from '../git/service';
import { capText, redactSecrets } from '../safety/redact';
import type { TerminalManager } from '../terminals/manager';
import type { Terminal } from '../terminals/terminal';
import type { WebClient } from '../web/client';
import type { SessionBackend } from './backend';
import { TmuxBackend, tmuxSessionName } from './backend';
import type { SessionEventStore } from './event-store';
import {
  alwaysLabelFrom,
  DEFAULT_DENY_MESSAGE,
  permissionDetail,
  permissionOptions,
  permissionTarget,
  permissionTitle,
  resolvedLabel,
} from './permission-text';
import {
  hashToken,
  newHookToken,
  readLaunchFile,
  removeTokenFile,
  sessionDir,
  updateLaunchFile,
  validateSessionEnv,
  writeSessionFiles,
  type LaunchFile,
} from './runtime-files';
import { sanitizeStatusLine, statusFingerprint } from './statusline';
import { planFromTodoWrite, toolOutcome, toolSummary, toolTarget } from './tool-meta';
import { findTranscript, placeTranscript, TranscriptTailer, transcriptsRoot, validateTranscriptPath, type TranscriptText } from './transcript';
import { startupScreenAction } from './startup-screens';
import { detectPermissionMode } from './composer-tools';
import {
  buildUsageLimit,
  DEFAULT_AUTO_RESUME_POLICY,
  detectLimitText,
  resetFromStatus,
  resolveReset,
  scheduleAutoResume,
  type AutoResumePolicy,
  type LimitText,
} from './usage-limit';

type SessionRow = typeof sessions.$inferSelect;
type PermissionRow = typeof permissionRequests.$inferSelect;
type SessionStatus = SessionRow['status'];
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nowIso = () => new Date().toISOString();
const LIVE: readonly string[] = LIVE_SESSION_STATUSES;

export interface HookDecisionOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: { behavior: 'allow'; updatedPermissions?: unknown[] } | { behavior: 'deny'; message: string };
  };
}

interface PendingPermission {
  id: string;
  resolve: (output: HookDecisionOutput | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LiveSession {
  id: string;
  projectId: string;
  /** Claude config folder of the project's account (lot P1): its login, transcripts, skills. */
  account: ClaudeAccount;
  worktreeId: string | null;
  cwd: string;
  title: string;
  backend: 'tmux' | 'pty';
  tmuxName: string | null;
  terminal: Terminal | null;
  tokenHash: string;
  permissionWaitSeconds: number;
  memoryLimitMb: number | null;
  ready: boolean;
  queue: string[];
  /** Instructions are typed one at a time (paste + Enter never interleave). */
  typing: Promise<void>;
  /** The queue is being typed into the CLI. */
  delivering: boolean;
  /** Last hook showing Claude at work (tool call, prompt…): tells whether an interrupt took effect. */
  lastActiveAt: number;
  pasted: Array<{ text: string; at: number }>;
  pending: Map<string, PendingPermission>;
  tailer: TranscriptTailer | null;
  turn: number;
  stopping: 'user' | 'shutdown' | 'memory' | null;
  sessionEnded: boolean;
  pid: number | null;
  readyTimer: ReturnType<typeof setTimeout> | null;
  detachExit: (() => void) | null;
  lastCliFingerprint: string;
  cliWriteTimer: ReturnType<typeof setTimeout> | null;
  pendingCli: CliStatus | null;
  toolSeq: number;
  /** Current step of the plan (TodoWrite in_progress item), preferred as « activité ». */
  planCurrent: string | null;
  /** Set once the process is gone and the final status is being written. */
  finalizing?: Promise<void>;
  /** How this run started: a plain start, `claude --resume` of the recorded conversation, a fresh CLI after a lost one. */
  launchMode: LaunchMode;
  /** Screen output until the CLI is ready (tells a refused `--resume` from another early exit). */
  bootOutput: string;
}

type LaunchMode = 'start' | 'conversation' | 'context';
type ResumeMode = Exclude<LaunchMode, 'start'>;

/** Ended statuses « Reprendre » accepts (a finished session can be taken up again too). */
const RESUMABLE_STATUSES: readonly string[] = ['interrupted', 'stopped', 'failed', 'finished'];

/** What the CLI prints when `--resume <id>` cannot open the conversation (it then exits). */
const RESUME_REFUSED = /No conversation found with session ID|Unable to load transcript|Failed to resume session|--resume file unreadable|--resume session load failed/i;

/** errorCode of a session whose recorded conversation the CLI refused to reopen. */
const RESUME_NOT_FOUND = 'resume_not_found';

export interface SessionManagerDeps {
  db: Database;
  /**
   * Common Claude configuration of each account of the server (rules, skills): refreshed before a
   * launch when it differs.
   */
  commonConfig?: { for(account: ClaudeAccount): Pick<CommonConfigSync, 'ensure' | 'lockedRulesFile'> } | null;
  /** Claude config folder of each account of the server (lot P1). */
  accounts: Pick<ClaudeAccounts, 'forSpace' | 'isolationDenyRules'>;
  /** Server of this runner: sessions are created, read, listed and reconciled within it only. */
  environment: EnvironmentScope;
  bus: EventBus;
  store: SessionEventStore;
  git: GitService;
  terminals: TerminalManager;
  backend: SessionBackend;
  web: WebClient;
  logger: Logger;
  dataDir: string;
  claudeBin: string | null;
  /** `http://127.0.0.1:<port>` of the hook listener (resolved after it listens). */
  hookBaseUrl: () => string;
  /** A session reported an authentication problem: refresh `claude auth status` of its account. */
  onAuthProblem: (account: ClaudeAccount) => void;
  /** Automatic resumption after the usage limit: margin, retries (NUERA_AUTO_RESUME_*; tests shorten them). */
  autoResume?: Partial<AutoResumePolicy>;
}

/** Stored usage-limit record of a row (unknown shapes count as none). */
export function parseUsageLimit(value: unknown): UsageLimit | null {
  if (!value) return null;
  const parsed = UsageLimitSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseCli(value: unknown): CliStatus | null {
  if (!value) return null;
  const parsed = CliStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** French copy of a usage-limit stop (session error line, notifications). */
export function usageLimitMessage(limit: UsageLimit, now: number = Date.now()): string {
  const resume = limit.autoResume;
  if (resume?.outcome === 'scheduled' && resume.nextAttemptAt) {
    return `Limite d'utilisation atteinte : reprise automatique à ${formatClockDay(resume.nextAttemptAt, now)}.`;
  }
  if (limit.resetsAt) return `Limite d'utilisation atteinte : levée à ${formatClockDay(limit.resetsAt, now)}.`;
  return "Limite d'utilisation atteinte.";
}

/** Delay before a new try when the automatic resumption could not run (capacity reached, permission pending). */
const AUTO_RESUME_BUSY_RETRY_MS = 5 * 60_000;
/** Refusals after which an automatic resumption is not tried again. */
const AUTO_RESUME_FINAL_REASONS = new Set(['SESSION_NOT_RESUMABLE', 'WORKTREE_MISSING', 'CLAUDE_NOT_INSTALLED', 'BYPASS_BLOCKED', 'RESUME_CONTEXT_REQUIRED']);
/** Longest single timer; a later attempt is re-armed on wake-up. */
const MAX_TIMER_MS = 60 * 60_000;
/** Composer chips: wait for « Set model to … », Maj+Tab presses before giving up on a mode. */
const MODEL_CONFIRM_MS = 6_000;
const MAX_MODE_PRESSES = 6;
const MODE_LABELS: Record<SessionRow['permissionMode'], string> = {
  manual: "Demander avant d'agir",
  acceptEdits: 'Accepter les modifications',
  plan: 'Planifier sans modifier',
  auto: 'Automatique',
  dontAsk: 'Refuser sans demander',
  bypassPermissions: 'Sans autorisation',
};

const STOP_FAILURE_MESSAGES: Record<string, string> = {
  rate_limit: "Limite d'utilisation atteinte.",
  authentication_failed: "Claude Code n'est plus connecté à votre compte Claude.",
  oauth_org_not_allowed: "Ce compte Claude n'est pas autorisé pour Claude Code.",
  account_on_hold: 'Le compte Claude est suspendu.',
  billing_error: 'Problème de facturation sur le compte Claude.',
  overloaded: 'Le service Claude est surchargé, réessayez dans un instant.',
  server_error: 'Erreur du service Claude.',
  invalid_request: 'Requête refusée par Claude.',
  model_not_found: 'Modèle introuvable pour ce compte.',
  max_output_tokens: 'Réponse interrompue : limite de sortie atteinte.',
  cloud_credential_error: 'Identifiants du fournisseur cloud invalides.',
  unknown: 'Erreur inattendue du CLI.',
};
const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed']);

/** Hook wait for a decision taken in Nuera Dev when the launch options give none (space default). */
const DEFAULT_PERMISSION_WAIT_SECONDS = 120;

/** Delay after Échap / Ctrl+C without any activity hook before the step is considered stopped. */
const INTERRUPT_SETTLE_MS = 2500;

/**
 * Hooks showing that Claude is still at work. After a user interrupt Claude Code sends none: no
 * `Stop` ("does not run if the stoppage occurred due to a user interrupt") and no
 * `PostToolUse(Failure)` for the cancelled tool.
 */
function isActivityHook(event: string, p: Json): boolean {
  if (event === 'PostToolUse') return !(isObj(p.tool_response) && p.tool_response.interrupted === true);
  if (event === 'PostToolUseFailure') return p.is_interrupt !== true;
  return ['PreToolUse', 'UserPromptSubmit', 'SubagentStart', 'PreCompact', 'Stop', 'StopFailure'].includes(event);
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Cleans a pasted instruction: no bracketed-paste terminator, no control characters but \n and \t. */
/**
 * Web Push / notification copy of a permission request (Figma S5): title
 * « Tests e2e du devis attend votre accord », body « npm run test -- e2e · Nuera OS · touchez pour répondre ».
 * Without a target (rare tool inputs), the request title (« Exécuter une commande ») stands in for it.
 */
export function permissionNotificationCopy(input: { sessionTitle: string; projectName: string | null; target: string | null; requestTitle: string }): { title: string; body: string } {
  const oneLine = (text: string, max: number) => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
  };
  const subject = oneLine(input.target?.trim() ? input.target : input.requestTitle, 160);
  const parts = [subject, input.projectName ? oneLine(input.projectName, 80) : null, 'touchez pour répondre'].filter(Boolean);
  return { title: `${oneLine(input.sessionTitle, 150)} attend votre accord`, body: parts.join(' · ') };
}

export function sanitizeInstruction(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u001b\[20[01]~/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

const normalizeText = (t: string) => t.replace(/\s+/g, ' ').trim();

function trimToolInput(input: unknown): Record<string, unknown> {
  if (!isObj(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = v.length > 4096 ? `${redactSecrets(v.slice(0, 4096))}…` : redactSecrets(v);
    else if (Array.isArray(v)) out[k] = v.length > 50 ? `[${v.length} éléments]` : v;
    else out[k] = v;
  }
  return out;
}

const activityVerbs: Record<string, string> = {
  Read: 'Lit',
  Edit: 'Modifie',
  MultiEdit: 'Modifie',
  Write: 'Écrit',
  NotebookEdit: 'Modifie',
  Bash: 'Exécute',
  PowerShell: 'Exécute',
  Glob: 'Recherche',
  Grep: 'Recherche',
  WebFetch: 'Consulte',
  WebSearch: 'Recherche sur le web',
  Task: 'Délègue',
  Agent: 'Délègue',
};

export class SessionManager {
  private readonly live = new Map<string, LiveSession>();
  /** Launches in progress: a second start/resume/instruction joins the same run (never two CLIs). */
  private readonly launching = new Map<string, Promise<void>>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /** Automatic resumptions waiting for their time (rebuilt from `sessions.usage_limit` at start-up). */
  private readonly resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Instruction typed by an automatic resumption: its UserPromptSubmit does not cancel the schedule. */
  private readonly autoPrompts = new Map<string, string>();
  private readonly policy: AutoResumePolicy;
  /** Last permission mode the CLI reported for a live session (hooks), to write only its changes. */
  private readonly reportedModes = new Map<string, SessionRow['permissionMode']>();
  /** Last effort level the CLI reported for a live session (hooks), to write only its changes. */
  private readonly reportedEfforts = new Map<string, string>();

  constructor(private readonly deps: SessionManagerDeps) {
    this.policy = { ...DEFAULT_AUTO_RESUME_POLICY, ...Object.fromEntries(Object.entries(deps.autoResume ?? {}).filter(([, v]) => v !== undefined)) };
  }

  /** Id of this runner's server (throws while it does not serve). */
  private get envId(): string {
    return this.deps.environment.id;
  }

  /** WHERE clause of a write to one of this server's sessions (defense in depth). */
  private ownSession(sessionId: string) {
    return and(eq(sessions.id, sessionId), eq(sessions.environmentId, this.envId));
  }

  /** Same config dir as the session CLI's (its account's): the only place its transcripts may live. */
  private transcriptRoot(live: Pick<LiveSession, 'account'>): string {
    return transcriptsRoot(live.account.configDir);
  }

  /**
   * `projects/` folders where THIS account's conversations may be (never another account's): its
   * own config folder first; for the server's first account, also the folders it used before
   * (CLAUDE_CONFIG_DIR of the runner, `~/.claude` of its HOME) — a change of NUERA_CLAUDE_CONFIG_DIR
   * or of the container's HOME must not lose its conversations.
   */
  private transcriptRoots(account: ClaudeAccount): string[] {
    const roots = [transcriptsRoot(account.configDir)];
    if (account.primary) {
      const env = process.env.CLAUDE_CONFIG_DIR?.trim();
      if (env) roots.push(path.join(env, 'projects'));
      roots.push(path.join(os.homedir(), '.claude', 'projects'));
    }
    return [...new Set(roots.map((root) => path.resolve(root)))];
  }

  /** Conversation recorded by Claude Code for this session, wherever it lies in the account's folders. */
  private async findConversation(row: SessionRow, account: ClaudeAccount, cwd: string) {
    return findTranscript({ conversationId: row.claudeSessionId ?? row.id, recordedPath: row.transcriptPath, roots: this.transcriptRoots(account), cwd });
  }

  /**
   * « Reprendre » of an ended session: possible unless archived (or its project is), and what it
   * will do — reopen the recorded conversation, or start a fresh CLI when it is gone (a session
   * that never received an instruction has nothing to lose: same conversation id, afresh).
   */
  private async resumePlan(row: SessionRow, worktree: WorktreeRow | null): Promise<{ resumable: boolean; mode: ResumeMode | null }> {
    if (!RESUMABLE_STATUSES.includes(row.status) || row.archivedAt) return { resumable: false, mode: null };
    const project = await getProject(this.deps.db, this.envId, row.projectId).catch(() => null);
    if (!project || project.status !== 'ready' || project.archivedAt) return { resumable: false, mode: null };
    if (row.errorCode === RESUME_NOT_FOUND) return { resumable: true, mode: 'context' };
    const account = await this.deps.accounts.forSpace(project.spaceId).catch(() => null);
    const cwd = worktree && worktree.status !== 'removed' ? worktree.path : project.path;
    const found = account ? await this.findConversation(row, account, cwd) : null;
    if (found) return { resumable: true, mode: 'conversation' };
    return { resumable: true, mode: (await this.countTurns(row.id)) === 0 ? 'conversation' : 'context' };
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  liveSessionForWorktree = (worktreeId: string): string | null => {
    for (const s of this.live.values()) if (s.worktreeId === worktreeId) return s.id;
    return null;
  };

  get liveCount(): number {
    return [...this.live.values()].filter((s) => !s.stopping).length;
  }

  isLive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  private async row(sessionId: string): Promise<SessionRow> {
    return getSessionRow(this.deps.db, this.envId, sessionId);
  }

  private permissionDto(row: PermissionRow, cwd: string | null): PermissionRequestDto {
    const suggestions = (row.suggestions ?? null) as unknown[] | null;
    const alwaysLabel = alwaysLabelFrom(suggestions, cwd);
    return {
      id: row.id,
      sessionId: row.sessionId,
      toolName: row.toolName,
      title: row.title,
      target: row.target,
      detail: row.detail,
      status: row.status,
      options: permissionOptions(alwaysLabel),
      alwaysLabel,
      suggestions,
      decisionMessage: row.decisionMessage,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    };
  }

  private async pendingPermissionRow(sessionId: string): Promise<PermissionRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(permissionRequests)
      .where(and(eq(permissionRequests.sessionId, sessionId), eq(permissionRequests.status, 'pending')))
      .orderBy(desc(permissionRequests.createdAt))
      .limit(1);
    return row ?? null;
  }

  async dto(sessionOrId: string | SessionRow): Promise<SessionDto> {
    const row = typeof sessionOrId === 'string' ? await this.row(sessionOrId) : sessionOrId;
    const live = this.live.get(row.id);
    let worktree: WorktreeRow | null = null;
    if (row.worktreeId) {
      const [w] = await this.deps.db.select().from(worktrees).where(eq(worktrees.id, row.worktreeId)).limit(1);
      worktree = w ?? null;
    }
    const pending = await this.pendingPermissionRow(row.id);
    const plan = live ? null : await this.resumePlan(row, worktree);
    return {
      id: row.id,
      projectId: row.projectId,
      worktreeId: row.worktreeId,
      title: row.title,
      status: row.status,
      backend: row.backend,
      tmuxName: row.tmuxName,
      permissionMode: row.permissionMode,
      model: row.model,
      effort: row.effort,
      remoteControl: row.remoteControl,
      remoteControlUrl: row.remoteControlUrl,
      live: Boolean(live),
      resumable: plan?.resumable ?? false,
      resumeMode: live ? (live.launchMode === 'start' ? null : live.launchMode) : (plan?.mode ?? null),
      pid: live?.pid ?? null,
      terminalId: live?.terminal?.id ?? null,
      lastInstruction: row.lastInstruction,
      currentActivity: row.currentActivity,
      planDone: row.planDone,
      planTotal: row.planTotal,
      cliStatus: (row.cliStatus as CliStatus | null) ?? null,
      pendingPermission: pending ? this.permissionDto(pending, worktree?.path ?? null) : null,
      queuedInstructions: live?.queue.length ?? 0,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      limit: parseUsageLimit(row.usageLimit),
      exitCode: row.exitCode,
      resumeCount: row.resumeCount,
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      lastActivityAt: row.lastActivityAt ? row.lastActivityAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      worktree: worktree
        ? { id: worktree.id, name: worktree.name, branch: worktree.branch, baseBranch: worktree.baseBranch, path: worktree.path, isPrimary: worktree.isPrimary }
        : null,
    };
  }

  async list(): Promise<{ sessions: SessionDto[]; capacity: { live: number; max: number } }> {
    const rows = await this.deps.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.environmentId, this.envId), inArray(sessions.status, [...LIVE_SESSION_STATUSES, 'new'])));
    const result: SessionDto[] = [];
    for (const row of rows) result.push(await this.dto(row));
    return { sessions: result, capacity: { live: this.liveCount, max: await this.maxSessions() } };
  }

  /** Number of instructions already recorded (turn counter survives resumes and restarts). */
  private async countTurns(sessionId: string): Promise<number> {
    const [row] = await this.deps.db
      .select({ n: sql<number>`count(*)` })
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.kind, 'instruction')));
    return Number(row?.n ?? 0);
  }

  /**
   * The server's own setting (`environments.max_concurrent_sessions`, capped by the administration);
   * a launch value (older webs, or a `launch.json` written before the server existed) may only be
   * stricter, never above it.
   */
  async maxSessions(override?: number | null): Promise<number> {
    const serverMax = (await this.deps.environment.settings()).maxConcurrentSessions;
    return override ? Math.min(override, serverMax) : serverMax;
  }

  // -------------------------------------------------------------------------------------------
  // Status updates
  // -------------------------------------------------------------------------------------------

  private async setSession(sessionId: string, patch: Partial<typeof sessions.$inferInsert>): Promise<SessionRow> {
    const [row] = await this.deps.db
      .update(sessions)
      .set({ ...patch, lastActivityAt: patch.lastActivityAt ?? new Date() })
      .where(this.ownSession(sessionId))
      .returning();
    if (!row) throw new RunnerError('NOT_FOUND', 'Session introuvable.');
    await this.publishStatus(row);
    return row;
  }

  private async publishStatus(row: SessionRow): Promise<void> {
    const pending = await this.pendingPermissionRow(row.id);
    const live = this.live.get(row.id);
    const data: SessionStatusEvent = {
      sessionId: row.id,
      projectId: row.projectId,
      status: row.status,
      title: row.title,
      live: Boolean(live),
      currentActivity: row.currentActivity,
      lastInstruction: row.lastInstruction,
      lastActivityAt: row.lastActivityAt ? row.lastActivityAt.toISOString() : null,
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      planDone: row.planDone,
      planTotal: row.planTotal,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      cliStatus: (row.cliStatus as CliStatus | null) ?? null,
      pendingPermissionId: pending?.id ?? null,
      remoteControlUrl: row.remoteControlUrl,
      queuedInstructions: live?.queue.length ?? 0,
      limit: parseUsageLimit(row.usageLimit),
      permissionMode: row.permissionMode,
      model: row.model,
      effort: row.effort,
    };
    this.deps.bus.publish('session.status', data, { channels: [GLOBAL, sessionChannel(row.id)] });
  }

  /**
   * The web changed the row itself (archive, rename): publish its status so every open tab follows;
   * a live session also keeps the new title for its notifications.
   */
  async announce(sessionId: string): Promise<SessionDto> {
    const row = await this.row(sessionId);
    const live = this.live.get(sessionId);
    if (live) live.title = row.title;
    await this.publishStatus(row);
    return this.dto(row);
  }

  // -------------------------------------------------------------------------------------------
  // Create / start / resume
  // -------------------------------------------------------------------------------------------

  async create(input: {
    sessionId?: string;
    projectId: string;
    title: string;
    worktree: { mode: 'new'; branch: string; name?: string; base?: string } | { mode: 'existing'; worktreeId: string } | { mode: 'primary' };
    permissionMode: SessionRow['permissionMode'];
    model?: string | null;
    effort?: string | null;
    remoteControl: boolean;
    launch: SessionLaunchOptions;
    start: boolean;
    createdByUserId?: string | null;
  }): Promise<SessionDto> {
    const project = await getReadyProject(this.deps.db, this.envId, input.projectId);
    await this.deps.environment.assertCanStartWork();
    await this.assertModeAllowed(input.permissionMode, input.launch.blockBypassPermissions);
    validateSessionEnv(input.launch.env ?? {});
    validateSessionEnv(input.launch.settingsEnv ?? {});
    if (input.start) await this.assertCapacity(input.launch.maxConcurrentSessions ?? null);
    const id = input.sessionId ?? randomUUID();
    const rowValues = (worktreeId: string | null): typeof sessions.$inferInsert => ({
      id,
      projectId: project.id,
      environmentId: project.environmentId,
      worktreeId,
      title: input.title,
      status: 'new',
      backend: this.deps.backend.kind,
      permissionMode: input.permissionMode,
      model: input.model ?? null,
      effort: input.effort ?? null,
      remoteControl: input.remoteControl,
      // `--session-id` of the first launch; replaced by the id the CLI reports (SessionStart).
      claudeSessionId: id,
      createdByUserId: input.createdByUserId ?? null,
    });
    // A caller-supplied id is checked before any side effect (a worktree created in 'new' mode).
    if (input.sessionId) await this.assertSessionIdFree(rowValues(null));
    let worktree: WorktreeRow;
    if (input.worktree.mode === 'existing') {
      worktree = await getWorktree(this.deps.db, this.envId, input.worktree.worktreeId);
      if (worktree.projectId !== project.id) throw new RunnerError('NOT_FOUND', 'Worktree introuvable pour ce projet.');
    } else if (input.worktree.mode === 'primary') {
      worktree = (await this.deps.git.resolveProjectWorktree(project.id)).worktree;
    } else {
      worktree = await this.deps.git.createWorktree(
        project.id,
        { name: input.worktree.name, branch: input.worktree.branch, base: input.worktree.base, actorUserId: input.createdByUserId },
        {},
      );
    }
    const busy = this.liveSessionForWorktree(worktree.id);
    if (busy) throw new RunnerError('CONFLICT', 'Une session tourne déjà dans ce worktree.', { reason: 'WORKTREE_IN_USE', data: { sessionId: busy } });

    await this.deps.db
      .insert(sessions)
      .values(rowValues(worktree.id))
      .catch((error: unknown) => {
        // A row of another server is invisible here (restricted role), but its id stays unique.
        if (isUniqueViolation(error)) throw new RunnerError('CONFLICT', 'Une session porte déjà cet identifiant.');
        throw error;
      });
    const settings = await this.deps.environment.settings();
    await writeSessionFiles(this.deps.dataDir, {
      sessionId: id,
      claudeSessionId: id,
      launch: {
        denyRules: input.launch.denyRules ?? [],
        env: input.launch.env ?? {},
        mcpConfig: input.launch.mcpConfig ?? null,
        allowRules: input.launch.allowRules ?? [],
        askRules: input.launch.askRules ?? [],
        settingsEnv: input.launch.settingsEnv ?? {},
        commonConfig: input.launch.commonConfig ?? null,
      },
      permissionWaitSeconds: input.launch.permissionWaitSeconds ?? DEFAULT_PERMISSION_WAIT_SECONDS,
      maxConcurrentSessions: input.launch.maxConcurrentSessions ?? null,
      memoryLimitMb: input.launch.memoryLimitMb ?? settings.sessionMemoryLimitMb,
      hookToken: null,
      ...(input.launch.blockBypassPermissions !== undefined ? { blockBypassPermissions: input.launch.blockBypassPermissions } : {}),
      gitIdentity: input.launch.gitIdentity ?? null,
      autoResume: input.launch.autoResume ?? null,
    });
    if (input.start) await this.launch(id, { resume: false, queue: [] });
    return this.dto(id);
  }

  /**
   * A caller-supplied session id must be free. The probe is the insert itself, rolled back: the
   * primary key is unique across servers, and a row of another server is invisible to a restricted
   * role (RLS), so a SELECT would answer differently under the full DSN and under that role. The
   * same CONFLICT whatever server holds the id, and nothing is created when it is taken.
   */
  private async assertSessionIdFree(values: typeof sessions.$inferInsert): Promise<void> {
    try {
      await this.deps.db.transaction(async (tx) => {
        await tx.insert(sessions).values(values);
        throw PROBE_ROLLBACK;
      });
    } catch (error) {
      if (error === PROBE_ROLLBACK) return;
      if (isUniqueViolation(error)) throw new RunnerError('CONFLICT', 'Une session porte déjà cet identifiant.');
      throw error;
    }
  }

  /** « 2 sessions actives sur 4 autorisées » — refuse a new live CLI above the cap. */
  private async assertCapacity(override: number | null): Promise<void> {
    this.assertCapacityFor(await this.maxSessions(override));
  }

  private assertCapacityFor(max: number): void {
    if (this.liveCount >= max) {
      throw new RunnerError('CONFLICT', `${this.liveCount} sessions actives sur ${max} autorisées : arrêtez-en une avant d'en démarrer une autre.`, {
        reason: 'CAPACITY_REACHED',
        data: { live: this.liveCount, max },
      });
    }
  }

  /**
   * « Bloquer le mode sans autorisation »: the effective value comes with the launch options
   * (computed by the web: instance OR space), blocked when absent; the instance-wide forced block
   * (`app_settings.force_block_bypass_permissions`) always wins.
   */
  private async assertModeAllowed(mode: SessionRow['permissionMode'], blockFromLaunch: boolean | undefined): Promise<void> {
    if (mode !== 'bypassPermissions') return;
    const blocked = (blockFromLaunch ?? true) || (await this.deps.environment.forceBlockBypass());
    if (blocked) {
      throw new RunnerError('FORBIDDEN', 'Le mode sans autorisation est bloqué dans les paramètres.', { reason: 'BYPASS_BLOCKED' });
    }
  }

  /** Live or being launched right now. */
  private isActive(sessionId: string): boolean {
    return this.live.has(sessionId) || this.launching.has(sessionId);
  }

  async start(sessionId: string, launch?: Partial<SessionLaunchOptions>): Promise<SessionDto> {
    const row = await this.row(sessionId);
    if (this.isActive(sessionId)) {
      await this.launch(sessionId, { resume: false, queue: [] });
      return this.dto(sessionId);
    }
    if (row.status !== 'new') return this.resume(sessionId, launch);
    if (launch) await this.refreshLaunch(sessionId, launch);
    await this.launch(sessionId, { resume: false, queue: [] });
    return this.dto(sessionId);
  }

  /**
   * « Reprendre » — never a dead end while the session and its project are not archived:
   * 1. the worktree is recreated from its branch when it was removed (local branch, else the remote
   *    one, else a new branch from the project's default branch), the session keeps its id;
   * 2. the conversation recorded by Claude Code is looked up by its id in the account's folders and
   *    put where `claude --resume <id>` reads it (worktree path, HOME or config folder changed);
   * 3. found: `claude --resume`; never begun: the same id afresh; gone (retention, folder lost, CLI
   *    refusal): a fresh CLI under a new conversation id — only with `fresh` (the owner's choice,
   *    with or without the context built by the web from the stored history), else
   *    RESUME_CONTEXT_REQUIRED and nothing is touched.
   */
  async resume(
    sessionId: string,
    launch?: Partial<SessionLaunchOptions>,
    queue: string[] = [],
    options: { fresh?: { context: string | null }; actorUserId?: string | null } = {},
  ): Promise<SessionDto> {
    const row = await this.row(sessionId);
    if (this.isActive(sessionId)) {
      // Already running (or starting): the instructions join that run.
      await this.launch(sessionId, { resume: false, queue });
      return this.dto(sessionId);
    }
    if (row.status === 'archived' || row.archivedAt) throw new RunnerError('CONFLICT', 'Session archivée.', { reason: 'SESSION_NOT_RESUMABLE' });
    if (row.status === 'new') {
      if (launch) await this.refreshLaunch(sessionId, launch);
      await this.launch(sessionId, { resume: false, queue });
      return this.dto(sessionId);
    }
    const project = await getReadyProject(this.deps.db, this.envId, row.projectId);
    if (project.archivedAt) throw new RunnerError('CONFLICT', 'Projet archivé : ses sessions ne peuvent plus être reprises.', { reason: 'SESSION_NOT_RESUMABLE' });
    const account = await this.deps.accounts.forSpace(project.spaceId);
    let currentCwd = project.path;
    if (row.worktreeId) {
      const [w] = await this.deps.db.select().from(worktrees).where(and(eq(worktrees.id, row.worktreeId), eq(worktrees.environmentId, this.envId))).limit(1);
      if (w && w.status !== 'removed') currentCwd = w.path;
    }
    const found = row.errorCode === RESUME_NOT_FOUND ? null : await this.findConversation(row, account, currentCwd);
    const turns = found ? null : await this.countTurns(sessionId);
    const fresh = !found && (row.errorCode === RESUME_NOT_FOUND || (turns ?? 0) > 0);
    if (fresh && !options.fresh) {
      throw new RunnerError('CONFLICT', "La conversation enregistrée par Claude Code est introuvable : reprenez la session avec un nouveau contexte.", {
        reason: 'RESUME_CONTEXT_REQUIRED',
        untouched: "Rien n'a été modifié.",
        data: { mode: 'context' },
      });
    }
    // Nothing is checked after this point that could leave a half-done resumption behind.
    const worktree = await this.ensureSessionWorktree(row, options.actorUserId ?? null);
    if (launch) await this.refreshLaunch(sessionId, launch);
    if (found) {
      const placed = await placeTranscript(
        (await this.findConversation({ ...row, transcriptPath: found.path }, account, worktree.cwd)) ?? found,
      );
      await this.deps.db.update(sessions).set({ transcriptPath: placed }).where(this.ownSession(sessionId));
      if (worktree.notice) await this.appendSystem(sessionId, worktree.notice);
      await this.launch(sessionId, { resume: true, queue, mode: 'conversation' });
      return this.dto(sessionId);
    }
    if (!fresh) {
      // Started, then stopped before anything was said (the CLI writes its journal at the first
      // message): nothing to resume, the same conversation id simply starts afresh.
      if (worktree.notice) await this.appendSystem(sessionId, worktree.notice);
      await this.launch(sessionId, { resume: false, queue });
      return this.dto(sessionId);
    }
    // A fresh CLI in the same Nuera session (same thread): a new conversation id, the context first.
    const conversationId = randomUUID();
    await this.deps.db
      .update(sessions)
      .set({ claudeSessionId: conversationId, transcriptPath: null, errorCode: null, errorMessage: null })
      .where(this.ownSession(sessionId));
    await updateLaunchFile(this.deps.dataDir, sessionId, { claudeSessionId: conversationId });
    const context = options.fresh?.context ?? null;
    await this.appendSystem(
      sessionId,
      [
        "Reprise avec un nouveau contexte : la conversation enregistrée par Claude Code est introuvable sur le serveur, l'historique de Nuera Dev reste affiché.",
        context ? 'Un résumé de cet historique est envoyé comme première instruction.' : 'Aucun résumé envoyé : Claude repart sans le contexte précédent.',
        worktree.notice,
      ]
        .filter(Boolean)
        .join(' '),
    );
    await this.launch(sessionId, { resume: false, queue: context ? [context, ...queue] : queue, mode: 'context' });
    return this.dto(sessionId);
  }

  private async appendSystem(sessionId: string, message: string): Promise<void> {
    await this.deps.store.queue.run(sessionId, async () => {
      await this.deps.store.append(sessionId, 'system', { message, at: nowIso() });
    });
  }

  /**
   * Worktree a resumption runs in: the session's own when its folder is there; otherwise one is
   * recreated on its branch (git service `restoreWorktree`) and the session points to it. A missing
   * primary clone is the project folder itself: not recreated here (WORKTREE_MISSING).
   */
  private async ensureSessionWorktree(row: SessionRow, actorUserId: string | null): Promise<{ worktreeId: string; cwd: string; notice: string | null }> {
    let previous: WorktreeRow | null = null;
    if (row.worktreeId) {
      const [w] = await this.deps.db.select().from(worktrees).where(and(eq(worktrees.id, row.worktreeId), eq(worktrees.environmentId, this.envId))).limit(1);
      previous = w ?? null;
      if (previous && previous.status !== 'removed') {
        try {
          const { cwd } = await this.deps.git.resolveWorktree(previous.id);
          return { worktreeId: previous.id, cwd, notice: null };
        } catch (error) {
          if (!(error instanceof RunnerError) || (error.reason !== 'WORKTREE_MISSING' && error.code !== 'NOT_FOUND')) throw error;
          if (previous.isPrimary) throw error;
        }
      }
    }
    const branch = previous?.branch ?? `reprise/${row.id.slice(0, 8)}`;
    const restored = await this.deps.git.restoreWorktree(row.projectId, {
      branch,
      name: previous?.name,
      previousId: previous && !previous.isPrimary ? previous.id : null,
      actorUserId,
      sessionId: row.id,
    });
    await this.deps.db.update(sessions).set({ worktreeId: restored.worktree.id }).where(this.ownSession(row.id));
    const notices: Record<typeof restored.origin, string> = {
      existing: `Worktree ${restored.worktree.name} réutilisé : il était déjà ouvert sur la branche ${branch}.`,
      local: `Worktree ${restored.worktree.name} recréé depuis la branche locale ${branch}.`,
      remote: `Worktree ${restored.worktree.name} recréé depuis la branche distante origin/${branch}.`,
      default: `La branche ${branch} n'existe plus (ni localement ni sur le dépôt distant) : worktree ${restored.worktree.name} recréé depuis la branche par défaut ${restored.base}, les modifications non poussées de l'ancien worktree sont perdues.`,
    };
    return { worktreeId: restored.worktree.id, cwd: restored.cwd, notice: notices[restored.origin] };
  }

  private async refreshLaunch(sessionId: string, launch: Partial<SessionLaunchOptions>): Promise<void> {
    const current = await readLaunchFile(this.deps.dataDir, sessionId);
    if (launch.env) validateSessionEnv(launch.env);
    if (launch.settingsEnv) validateSessionEnv(launch.settingsEnv);
    const blockBypass = launch.blockBypassPermissions ?? current?.blockBypassPermissions;
    const [stored] = await this.deps.db.select({ claudeSessionId: sessions.claudeSessionId }).from(sessions).where(this.ownSession(sessionId)).limit(1);
    await writeSessionFiles(this.deps.dataDir, {
      sessionId,
      claudeSessionId: stored?.claudeSessionId ?? current?.claudeSessionId ?? sessionId,
      launch: {
        denyRules: launch.denyRules ?? current?.denyRules ?? [],
        env: launch.env ?? current?.env ?? {},
        mcpConfig: launch.mcpConfig === undefined ? undefined : launch.mcpConfig,
        allowRules: launch.allowRules ?? current?.allowRules ?? [],
        askRules: launch.askRules ?? current?.askRules ?? [],
        settingsEnv: launch.settingsEnv ?? current?.settingsEnv ?? {},
        commonConfig: launch.commonConfig === undefined ? (current?.commonConfig ?? null) : launch.commonConfig,
      },
      permissionWaitSeconds: launch.permissionWaitSeconds ?? current?.permissionWaitSeconds ?? DEFAULT_PERMISSION_WAIT_SECONDS,
      maxConcurrentSessions: launch.maxConcurrentSessions ?? current?.maxConcurrentSessions ?? null,
      memoryLimitMb: launch.memoryLimitMb ?? current?.memoryLimitMb ?? null,
      hookToken: null,
      ...(blockBypass !== undefined ? { blockBypassPermissions: blockBypass } : {}),
      // The account resuming the session signs Claude's next commits (null clears, absent keeps).
      gitIdentity: launch.gitIdentity === undefined ? (current?.gitIdentity ?? null) : launch.gitIdentity,
      autoResume: launch.autoResume === undefined ? (current?.autoResume ?? null) : launch.autoResume,
    });
  }

  /**
   * Spawns the CLI for a new or resumed conversation — at most one launch per session: a call made
   * while the session is live or starting only hands its instructions to that run.
   */
  private async launch(sessionId: string, options: { resume: boolean; queue: string[]; mode?: LaunchMode }): Promise<void> {
    // Synchronous check-and-set (before any await): two concurrent calls never both spawn a CLI.
    const inflight = this.launching.get(sessionId);
    if (inflight || this.live.has(sessionId)) {
      if (inflight) await inflight;
      await this.enqueue(sessionId, options.queue);
      return;
    }
    const run = this.spawnCli(sessionId, options);
    this.launching.set(sessionId, run);
    try {
      await run;
    } finally {
      if (this.launching.get(sessionId) === run) this.launching.delete(sessionId);
    }
  }

  /** Instructions for a session that is already live: queued until it is ready, else typed in order. */
  private async enqueue(sessionId: string, texts: string[]): Promise<void> {
    if (texts.length === 0) return;
    const live = this.live.get(sessionId);
    if (!live || live.stopping) throw new RunnerError('CONFLICT', "La session n'est plus active.", { reason: 'SESSION_NOT_LIVE' });
    if (live.pending.size > 0) throw new RunnerError('CONFLICT', "Répondez d'abord à la demande d'autorisation.", { reason: 'SESSION_BUSY_PERMISSION' });
    if (!live.ready || live.queue.length > 0) {
      live.queue.push(...texts);
      if (live.ready && !live.delivering) void this.deliverQueue(live);
      await this.publishStatus(await this.row(sessionId));
      return;
    }
    for (const text of texts) await this.paste(live, text);
  }

  private async spawnCli(sessionId: string, options: { resume: boolean; queue: string[]; mode?: LaunchMode }): Promise<void> {
    const row = await this.row(sessionId);
    await this.deps.environment.assertCanStartWork();
    if (!row.worktreeId) throw new RunnerError('CONFLICT', "La session n'a plus de worktree.", { reason: 'WORKTREE_MISSING' });
    const { project, worktree, cwd } = await this.deps.git.resolveWorktree(row.worktreeId);
    // The account of the project's space: ITS Claude login, never another account's of this server.
    const account = await this.deps.accounts.forSpace(project.spaceId);
    const busy = this.liveSessionForWorktree(worktree.id);
    if (busy && busy !== sessionId) throw new RunnerError('CONFLICT', 'Une session tourne déjà dans ce worktree.', { reason: 'WORKTREE_IN_USE' });
    let launchFile: LaunchFile | null = await readLaunchFile(this.deps.dataDir, sessionId);
    if (!launchFile) {
      const settings = await this.deps.environment.settings();
      await writeSessionFiles(this.deps.dataDir, {
        sessionId,
        claudeSessionId: row.claudeSessionId ?? sessionId,
        launch: { denyRules: [], env: {}, mcpConfig: null },
        permissionWaitSeconds: DEFAULT_PERMISSION_WAIT_SECONDS,
        maxConcurrentSessions: null,
        memoryLimitMb: settings.sessionMemoryLimitMb,
        hookToken: null,
      });
      launchFile = await readLaunchFile(this.deps.dataDir, sessionId);
    }
    if (!launchFile) throw new RunnerError('INTERNAL', 'Fichiers de session illisibles.');
    await this.assertModeAllowed(row.permissionMode, launchFile.blockBypassPermissions);
    const maxSessions = await this.maxSessions(launchFile.maxConcurrentSessions);
    const memoryLimitMb = tighterLimit(launchFile.memoryLimitMb, (await this.deps.environment.settings()).sessionMemoryLimitMb);
    this.assertCapacityFor(maxSessions);
    const claude = resolveClaudeCommand(this.deps.claudeBin);
    if (!claude) throw new RunnerError('CONFLICT', 'Le CLI Claude Code est introuvable sur le serveur.', { reason: 'CLAUDE_NOT_INSTALLED' });

    // The database is the reference (launch.json is only its copy next to the runtime files).
    const claudeSessionId = row.claudeSessionId ?? launchFile.claudeSessionId;
    const token = newHookToken();
    const tokenHash = hashToken(token);
    const isTmux = this.deps.backend.kind === 'tmux';
    // Rules and skills of the common configuration this session must start with (refreshed when the
    // copy of the server is older; a failure keeps the copy on disk and never blocks the launch).
    const common = this.deps.commonConfig?.for(account) ?? null;
    await common?.ensure(launchFile.commonConfig?.hash ?? null).catch((error: unknown) => {
      this.deps.logger.warn({ err: error, sessionId }, 'configuration commune non rafraîchie avant le lancement');
    });
    const lockedRules = common?.lockedRulesFile() ?? null;
    const files = await writeSessionFiles(this.deps.dataDir, {
      sessionId,
      claudeSessionId,
      launch: {
        denyRules: launchFile.denyRules,
        env: launchFile.env,
        mcpConfig: undefined,
        allowRules: launchFile.allowRules ?? [],
        askRules: launchFile.askRules ?? [],
        settingsEnv: launchFile.settingsEnv ?? {},
        commonConfig: launchFile.commonConfig ?? null,
        // Other accounts' Claude folders stay out of reach of Claude's file tools (shared server).
        isolationDenyRules: await this.deps.accounts.isolationDenyRules(account).catch(() => []),
      },
      permissionWaitSeconds: launchFile.permissionWaitSeconds,
      maxConcurrentSessions: launchFile.maxConcurrentSessions,
      memoryLimitMb: launchFile.memoryLimitMb,
      hookToken: isTmux ? token : null,
      ...(launchFile.blockBypassPermissions !== undefined ? { blockBypassPermissions: launchFile.blockBypassPermissions } : {}),
      gitIdentity: launchFile.gitIdentity ?? null,
      autoResume: launchFile.autoResume ?? null,
    });
    const mcpFile = launchFile.hasMcp ? `${sessionDir(this.deps.dataDir, sessionId)}/mcp.json` : null;

    const mode = row.permissionMode === 'manual' ? 'default' : row.permissionMode;
    const args = [
      ...(options.resume ? ['--resume', claudeSessionId] : ['--session-id', claudeSessionId]),
      '--name',
      row.title,
      '--permission-mode',
      mode,
      ...(row.model ? ['--model', row.model] : []),
      ...(row.effort ? ['--effort', row.effort] : []),
      '--settings',
      files.settings,
      // « Imposé » rules of the instance: appended to the system prompt (a project CLAUDE.md cannot
      // take precedence). The « Par défaut » ones are user-level memory (rules/nuera-commun.md).
      ...(lockedRules ? ['--append-system-prompt-file', lockedRules] : []),
      ...(mcpFile && existsSync(mcpFile) ? ['--mcp-config', mcpFile, '--strict-mcp-config'] : []),
      ...(row.remoteControl ? ['--remote-control', `${row.title} · ${project.name}`] : []),
    ];
    const sessionEnv: Record<string, string> = {
      ...launchFile.env,
      // Trusted values, after the free-form env (where they are refused anyway).
      ...gitIdentityEnv(launchFile.gitIdentity),
      ...claudeEnv(account.configDir),
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      NUERA_HOOK_URL: this.deps.hookBaseUrl(),
      NUERA_SESSION_ID: sessionId,
      ...(isTmux ? { NUERA_HOOK_TOKEN_FILE: files.tokenFile } : { NUERA_HOOK_TOKEN: token }),
    };

    let tmuxName: string | null = null;
    if (isTmux && this.deps.backend instanceof TmuxBackend) {
      const taken = new Set(await this.deps.backend.listSessions());
      tmuxName = row.tmuxName && !taken.has(row.tmuxName) ? row.tmuxName : tmuxSessionName(project.slug, worktree.name, taken);
    }

    const live: LiveSession = {
      id: sessionId,
      projectId: project.id,
      account,
      worktreeId: worktree.id,
      cwd,
      title: row.title,
      backend: this.deps.backend.kind,
      tmuxName,
      terminal: null,
      tokenHash,
      permissionWaitSeconds: launchFile.permissionWaitSeconds,
      memoryLimitMb,
      ready: false,
      queue: [...options.queue],
      typing: Promise.resolve(),
      delivering: false,
      lastActiveAt: Date.now(),
      pasted: [],
      pending: new Map(),
      tailer: null,
      turn: 0,
      stopping: null,
      sessionEnded: false,
      pid: null,
      readyTimer: null,
      detachExit: null,
      lastCliFingerprint: '',
      cliWriteTimer: null,
      pendingCli: null,
      toolSeq: 0,
      planCurrent: null,
      launchMode: options.mode ?? (options.resume ? 'conversation' : 'start'),
      bootOutput: '',
    };
    live.turn = await this.countTurns(sessionId);
    // Final checks and registration with no await in between: two launches of different sessions
    // can never both pass the cap, nor share a worktree.
    this.assertCapacityFor(maxSessions);
    const busyNow = this.liveSessionForWorktree(worktree.id);
    if (busyNow && busyNow !== sessionId) throw new RunnerError('CONFLICT', 'Une session tourne déjà dans ce worktree.', { reason: 'WORKTREE_IN_USE' });
    // Registered before spawning: the first hook may arrive before spawn() returns.
    this.live.set(sessionId, live);
    this.reportedEfforts.delete(sessionId);
    await this.deps.db
      .update(sessions)
      .set({
        hookTokenHash: tokenHash,
        backend: this.deps.backend.kind,
        tmuxName,
        claudeSessionId,
        status: options.queue.length ? 'running' : row.status === 'new' && !options.resume ? 'new' : 'waiting_input',
        startedAt: row.startedAt ?? new Date(),
        endedAt: null,
        exitCode: null,
        errorCode: null,
        errorMessage: null,
        currentActivity: 'Démarrage de Claude Code…',
        ...(options.resume || options.mode === 'context' ? { resumeCount: row.resumeCount + 1 } : {}),
      })
      .where(this.ownSession(sessionId));
    // First item of this run, queued before any hook of the new process can be processed.
    await this.deps.store.queue.run(sessionId, async () => {
      await this.deps.store.append(sessionId, 'status', {
        status: options.resume || live.launchMode === 'context' ? 'waiting_input' : 'new',
        label: live.launchMode === 'context' ? 'Session reprise avec un nouveau contexte' : options.resume ? 'Session reprise' : 'Session démarrée',
        at: nowIso(),
      });
    });

    try {
      const terminal = await this.deps.backend.start({
        sessionId,
        title: row.title,
        cwd,
        worktreeId: worktree.id,
        cols: 120,
        rows: 36,
        claude,
        args,
        sessionEnv,
        tmuxName,
      });
      live.terminal = terminal;
      this.watchTerminal(live, terminal);
      live.pid = await this.deps.backend.pid(terminal, tmuxName);
      if (live.pid && process.platform !== 'win32') {
        try {
          os.setPriority(live.pid, 10);
        } catch {
          // not permitted: keep the default priority
        }
      }
      await this.deps.db.update(sessions).set({ pid: live.pid }).where(this.ownSession(sessionId));
    } catch (error) {
      this.live.delete(sessionId);
      const message = error instanceof RunnerError ? error.message : "Le CLI Claude Code n'a pas pu démarrer.";
      await this.deps.store.queue.run(sessionId, async () => {
        await this.deps.store.append(sessionId, 'error', { code: 'spawn_failed', message, detail: null, at: nowIso() });
        await this.setSession(sessionId, { status: 'failed', errorCode: 'spawn_failed', errorMessage: message, currentActivity: null, endedAt: new Date() });
      });
      throw error;
    }

    live.readyTimer = setTimeout(() => {
      if (live.ready || !this.live.has(sessionId)) return;
      void this.deps.store.queue.run(sessionId, async () => {
        await this.setSession(sessionId, { currentActivity: 'Action requise dans le terminal (dialogue du CLI, confiance du dossier…)' });
      });
    }, 25_000);
    live.readyTimer.unref?.();

    await this.deps.store.queue.run(sessionId, async () => {
      await this.publishStatus(await this.row(sessionId));
    });
    this.ensureWatchdog();
  }

  private watchTerminal(live: LiveSession, terminal: Terminal): void {
    live.detachExit = terminal.onExit((code) => {
      void this.onTerminalExit(live, terminal, code);
    });
    if (!live.ready) {
      // Kept until the CLI is ready: a refused `--resume` prints its reason, then exits.
      const off = terminal.onOutput((data) => {
        if (live.ready || live.bootOutput.length > 16_000) {
          off();
          return;
        }
        live.bootOutput += data;
      });
    }
    this.answerStartupScreens(live, terminal);
  }

  /**
   * Tant que la session n'est pas prête (avant le premier hook) et pendant 3 min au plus : valide le
   * choix du thème, la confiance dans le dossier et les écrans « Press Enter to continue » du CLI
   * (`startup-screens.ts`). Une réponse par apparition d'écran ; jamais la connexion du compte.
   */
  private answerStartupScreens(live: LiveSession, terminal: Terminal): void {
    const state = { timer: null as ReturnType<typeof setTimeout> | null, lastScreen: '', answers: 0 };
    const deadline = Date.now() + 3 * 60_000;
    const stop = () => {
      if (state.timer) clearTimeout(state.timer);
      off();
    };
    const check = () => {
      state.timer = null;
      if (live.ready || live.stopping || !terminal.alive || this.live.get(live.id) !== live || Date.now() > deadline || state.answers >= 8) {
        stop();
        return;
      }
      const screen = terminal.screenText();
      const action = startupScreenAction(screen);
      if (!action || screen === state.lastScreen) return;
      state.lastScreen = screen;
      state.answers += 1;
      terminal.write(action.keys);
      this.deps.logger.info({ sessionId: live.id, screen: action.kind }, action.label);
    };
    const off = terminal.onOutput(() => {
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(check, 400);
    });
  }

  private async onTerminalExit(live: LiveSession, terminal: Terminal, code: number | null): Promise<void> {
    if (this.live.get(live.id) !== live) return;
    if (live.backend === 'tmux' && live.tmuxName && !live.stopping) {
      // The attach client died but the tmux session may still be alive: re-attach.
      const alive = await this.deps.backend.isAlive(terminal, live.tmuxName);
      if (alive && this.deps.backend instanceof TmuxBackend) {
        const next = this.deps.backend.attach(live.tmuxName, {
          sessionId: live.id,
          title: live.title,
          cwd: live.cwd,
          worktreeId: live.worktreeId,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        live.terminal = next;
        this.watchTerminal(live, next);
        return;
      }
    }
    await this.finalize(live, code);
  }

  /** The CLI process is gone: final status, pending permissions cancelled, files cleaned. */
  private finalize(live: LiveSession, exitCode: number | null): Promise<void> {
    if (live.finalizing) return live.finalizing;
    if (this.live.get(live.id) !== live) return Promise.resolve();
    live.finalizing = this.writeFinalState(live, exitCode);
    return live.finalizing;
  }

  private async writeFinalState(live: LiveSession, exitCode: number | null): Promise<void> {
    this.live.delete(live.id);
    if (live.readyTimer) clearTimeout(live.readyTimer);
    if (live.cliWriteTimer) clearTimeout(live.cliWriteTimer);
    live.tailer?.stop();
    for (const p of live.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    live.pending.clear();
    await removeTokenFile(this.deps.dataDir, live.id).catch(() => undefined);
    // `claude --resume` could not open the conversation (file unreadable, unknown to this CLI): the
    // next « Reprendre » starts a fresh CLI with the owner's choice of context.
    const resumeRefused =
      live.launchMode === 'conversation' && !live.ready && !live.stopping && exitCode !== 0 && RESUME_REFUSED.test(live.bootOutput.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ''));
    const status: SessionStatus =
      resumeRefused
        ? 'failed'
        : live.stopping === 'user'
        ? 'stopped'
        : live.stopping === 'shutdown'
          ? 'interrupted'
          : live.stopping === 'memory'
            ? 'failed'
            : live.sessionEnded || exitCode === 0
              ? 'finished'
              : 'failed';
    const label: Record<string, string> = {
      stopped: 'Session arrêtée',
      interrupted: 'Session interrompue · reprise possible',
      finished: 'Session terminée',
      failed: "Le processus Claude Code s'est arrêté",
    };
    await this.deps.store.queue.run(live.id, async () => {
      if (live.pendingCli) await this.flushCliStatus(live).catch(() => undefined);
      // The process is gone mid-step: its running tool lines will never finish.
      await this.closeRunningTools(live, 'interrupted').catch(() => undefined);
      await this.deps.db
        .update(permissionRequests)
        .set({ status: 'cancelled', decidedAt: new Date() })
        .where(and(eq(permissionRequests.sessionId, live.id), eq(permissionRequests.status, 'pending')));
      const statusLabel = resumeRefused ? 'Conversation introuvable : reprise avec un nouveau contexte proposée' : (label[status] ?? 'Session arrêtée');
      await this.deps.store.append(live.id, 'status', { status, label: statusLabel, at: nowIso() });
      await this.setSession(live.id, {
        status,
        pid: null,
        endedAt: new Date(),
        exitCode,
        currentActivity: null,
        ...(resumeRefused
          ? { errorCode: RESUME_NOT_FOUND, errorMessage: "Claude Code n'a pas pu rouvrir la conversation enregistrée : « Reprendre » repartira d'un nouveau contexte." }
          : status === 'failed' && live.stopping !== 'memory'
            ? { errorCode: 'process_exit', errorMessage: `Le processus Claude Code s'est arrêté (code ${exitCode ?? 'inconnu'}).` }
            : {}),
        ...(live.stopping === 'memory' ? { errorCode: 'memory_limit', errorMessage: 'Session arrêtée : plafond mémoire dépassé.' } : {}),
      });
    });
    if (status === 'failed' && !resumeRefused) {
      void this.notify(live, { kind: 'session_failed', severity: 'danger', title: `Session arrêtée : ${live.title}`, body: "Le processus Claude Code s'est arrêté.", dedupKey: `session:${live.id}:failed` });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Instructions, interrupt, stop
  // -------------------------------------------------------------------------------------------

  async sendInstruction(sessionId: string, text: string): Promise<{ delivered: boolean; queued: boolean; started: boolean; resumed: boolean; session: SessionDto }> {
    const clean = sanitizeInstruction(text);
    if (!clean.trim()) throw new RunnerError('VALIDATION', 'Instruction vide.');
    // The owner takes over: a scheduled automatic resumption is cancelled.
    await this.clearUsageLimit(sessionId);
    let live = this.live.get(sessionId);
    let started = false;
    let resumed = false;
    if (!live && !this.launching.has(sessionId)) {
      const row = await this.row(sessionId);
      if (!this.isActive(sessionId)) {
        if (row.status === 'new') {
          await this.launch(sessionId, { resume: false, queue: [clean] });
          started = true;
        } else {
          // The owner typed an instruction: a lost conversation restarts afresh with it (no summary).
          await this.resume(sessionId, undefined, [clean], { fresh: { context: null } });
          resumed = true;
        }
        return { delivered: false, queued: true, started, resumed, session: await this.dto(sessionId) };
      }
    }
    if (!live) {
      // Another call is launching the CLI (double click, start + instruction): join that run.
      await this.launching.get(sessionId)?.catch(() => undefined);
      live = this.live.get(sessionId);
      if (!live) throw new RunnerError('CONFLICT', "La session n'a pas pu démarrer.", { reason: 'SESSION_NOT_LIVE' });
    }
    if (live.stopping) throw new RunnerError('CONFLICT', "La session est en cours d'arrêt.", { reason: 'SESSION_NOT_LIVE' });
    if (live.pending.size > 0 || (await this.row(sessionId)).status === 'waiting_permission') {
      throw new RunnerError('CONFLICT', "Répondez d'abord à la demande d'autorisation.", { reason: 'SESSION_BUSY_PERMISSION' });
    }
    // Not ready yet, or earlier instructions still being typed: keep the order.
    if (!live.ready || live.queue.length > 0) {
      live.queue.push(clean);
      if (live.ready && !live.delivering) void this.deliverQueue(live);
      await this.publishStatus(await this.row(sessionId));
      return { delivered: false, queued: true, started, resumed, session: await this.dto(sessionId) };
    }
    await this.paste(live, clean);
    return { delivered: true, queued: false, started, resumed, session: await this.dto(sessionId) };
  }

  /** Bracketed paste + Enter, exactly what a human pasting into the TUI does — one at a time. */
  private paste(live: LiveSession, text: string): Promise<void> {
    const typed = live.typing.then(() => this.typeInstruction(live, text));
    live.typing = typed.catch(() => undefined);
    return typed;
  }

  private async typeInstruction(live: LiveSession, text: string): Promise<void> {
    const terminal = live.terminal;
    if (!terminal?.alive) throw new RunnerError('CONFLICT', 'Le terminal de la session est fermé.', { reason: 'SESSION_NOT_LIVE' });
    live.pasted.push({ text, at: Date.now() });
    live.pasted = live.pasted.filter((p) => Date.now() - p.at < 10 * 60_000).slice(-20);
    terminal.write(`\u001b[200~${text}\u001b[201~`);
    await new Promise((r) => setTimeout(r, 80));
    terminal.write('\r');
  }

  private async waitQuiet(terminal: Terminal, quietMs = 400, maxMs = 4000): Promise<void> {
    const started = Date.now();
    let last = Date.now();
    const off = terminal.onOutput(() => {
      last = Date.now();
    });
    try {
      while (Date.now() - started < maxMs && Date.now() - last < quietMs) await new Promise((r) => setTimeout(r, 50));
      while (Date.now() - started < maxMs && Date.now() - last < quietMs) await new Promise((r) => setTimeout(r, 50));
    } finally {
      off();
    }
  }

  /** Types the queued instructions once the CLI is ready (never throws: the queue is kept on failure). */
  private async deliverQueue(live: LiveSession): Promise<void> {
    if (!live.terminal || live.delivering) return;
    live.delivering = true;
    try {
      await this.waitQuiet(live.terminal);
      while (live.queue.length > 0 && this.live.get(live.id) === live && !live.stopping) {
        const next = live.queue[0]!;
        try {
          await this.paste(live, next);
        } catch (error) {
          this.deps.logger.warn({ err: error, sessionId: live.id }, 'instruction en file non transmise');
          return;
        }
        live.queue.shift();
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (error) {
      this.deps.logger.warn({ err: error, sessionId: live.id }, "file d'instructions interrompue");
    } finally {
      live.delivering = false;
    }
  }

  async interrupt(sessionId: string): Promise<SessionDto> {
    const live = this.live.get(sessionId);
    if (!live?.terminal?.alive) {
      // Unknown (or another server's) session: « introuvable », like every other session route.
      await this.row(sessionId);
      throw new RunnerError('CONFLICT', 'Aucun processus Claude Code actif pour cette session.', { reason: 'SESSION_NOT_LIVE' });
    }
    live.terminal.write('\u001b');
    this.noteInterrupt(sessionId);
    return this.dto(sessionId);
  }

  /**
   * Échap / Ctrl+C reached the CLI (Interrompre, or typed in the raw terminal). No hook follows a
   * user interrupt, so unless one shows that Claude carried on, the step is over: the tool lines
   * left « en cours » are closed and the session waits for an instruction again.
   */
  noteInterrupt(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    const at = Date.now();
    const timer = setTimeout(() => void this.settleAfterInterrupt(live, at), INTERRUPT_SETTLE_MS);
    timer.unref?.();
  }

  private async settleAfterInterrupt(live: LiveSession, at: number): Promise<void> {
    await this.deps.store.queue
      .run(live.id, async () => {
        if (this.live.get(live.id) !== live || live.stopping || live.lastActiveAt > at || live.pending.size > 0) return;
        const row = await this.row(live.id);
        if (row.status !== 'running' && row.status !== 'waiting_permission') return;
        await this.closeRunningTools(live, 'interrupted');
        await this.deps.store.append(live.id, 'status', { status: 'waiting_input', label: 'Étape interrompue', at: nowIso() });
        await this.setSession(live.id, { status: 'waiting_input', currentActivity: null });
      })
      .catch((error: unknown) => this.deps.logger.warn({ err: error, sessionId: live.id }, 'statut après interruption non mis à jour'));
  }

  /**
   * Tool lines still « en cours » although their step is over (interrupt, end of turn, process
   * gone): no PostToolUse will come for them. At the end of a turn, a tool that waited for a
   * permission answered in the terminal was refused there (an allowed one sends PostToolUse);
   * any other one finished without reporting (no meta is invented). A late hook still wins.
   */
  private async closeRunningTools(live: LiveSession, reason: 'interrupted' | 'turn_end'): Promise<void> {
    const tools = await this.deps.store.recent(live.id, 'tool', 30);
    for (const item of tools) {
      if (item.kind !== 'tool' || item.payload.status !== 'running' || !item.key) continue;
      await this.deps.store.update<'tool'>(live.id, item.key, (p) => {
        const finishedAt = nowIso();
        if (reason === 'interrupted') return { ...p, status: 'error', summary: 'interrompu', finishedAt };
        if (p.permissionId) return { ...p, status: 'denied', summary: toolSummary('denied', null), finishedAt };
        return { ...p, status: 'done', summary: null, finishedAt };
      });
    }
  }

  async stop(sessionId: string, options: { force: boolean }): Promise<SessionDto> {
    const live = this.live.get(sessionId);
    // Stopped by its owner: no automatic resumption any more.
    await this.clearUsageLimit(sessionId);
    if (!live) {
      const row = await this.row(sessionId);
      if (LIVE.includes(row.status)) {
        await this.setSession(sessionId, { status: 'stopped', endedAt: new Date(), pid: null, currentActivity: null });
      }
      return this.dto(sessionId);
    }
    live.stopping = 'user';
    await this.terminate(live, options.force);
    return this.dto(sessionId);
  }

  /** `/exit` then kill after a delay (or kill at once with force). */
  private async terminate(live: LiveSession, force: boolean): Promise<void> {
    const terminal = live.terminal;
    for (const p of live.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    if (!force && terminal?.alive) {
      terminal.write('\u001b');
      await new Promise((r) => setTimeout(r, 300));
      terminal.write('/exit');
      await new Promise((r) => setTimeout(r, 120));
      terminal.write('\r');
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && this.live.get(live.id) === live) {
        if (!(await this.deps.backend.isAlive(terminal, live.tmuxName))) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (this.live.get(live.id) === live) {
      await this.deps.backend.kill(terminal, live.tmuxName);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && this.live.get(live.id) === live) await new Promise((r) => setTimeout(r, 100));
      if (this.live.get(live.id) === live) await this.finalize(live, terminal?.exitCode ?? null);
    }
    // The answer reflects the final state (« stopped » written).
    if (live.finalizing) await live.finalizing.catch(() => undefined);
  }

  terminalFor(sessionId: string): Terminal | null {
    return this.live.get(sessionId)?.terminal ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // Composer chips: model (`/model` typed into the CLI) and permission mode (Maj+Tab)
  // -------------------------------------------------------------------------------------------

  /** `permission_mode` of a hook (« default » = Manual): stored when it changes, for the mode chip. */
  private async noteReportedMode(live: LiveSession, payload: Json): Promise<void> {
    const raw = str(payload.permission_mode);
    const mode = raw === 'default' ? 'manual' : raw;
    if (!mode || !(PERMISSION_MODES as readonly string[]).includes(mode)) return;
    const value = mode as SessionRow['permissionMode'];
    if (this.reportedModes.get(live.id) === value) return;
    this.reportedModes.set(live.id, value);
    try {
      await this.deps.store.queue.run(live.id, () => this.storeComposerOption(live.id, { permissionMode: value }));
    } catch (error) {
      this.deps.logger.warn({ err: error, sessionId: live.id }, 'mode de permission signalé non enregistré');
    }
  }

  /**
   * `effort` of a hook (a level, or `{ level }`): the effort the CLI really runs with, kept in the
   * stored status line (`cli_status.effort`) for the effort chip when it changes.
   */
  private async noteReportedEffort(live: LiveSession, payload: Json): Promise<void> {
    const raw = payload.effort;
    const level = typeof raw === 'string' ? raw : isObj(raw) ? str(raw.level) : null;
    if (!level || !/^[a-z]{2,16}$/.test(level) || this.reportedEfforts.get(live.id) === level) return;
    this.reportedEfforts.set(live.id, level);
    try {
      await this.deps.store.queue.run(live.id, () => this.storeReportedEffort(live.id, level));
    } catch (error) {
      this.deps.logger.warn({ err: error, sessionId: live.id }, 'effort signalé non enregistré');
    }
  }

  /** `cli_status.effort` = what the CLI reported (hook, status line, « Set effort level to … »); null = unknown. */
  private async storeReportedEffort(sessionId: string, level: string | null): Promise<SessionRow | null> {
    const [current] = await this.deps.db.select({ cliStatus: sessions.cliStatus }).from(sessions).where(this.ownSession(sessionId)).limit(1);
    const cli = parseCli(current?.cliStatus);
    if (cli && cli.effort === level) return null;
    const next: CliStatus = cli
      ? { ...cli, effort: level }
      : { receivedAt: nowIso(), version: null, model: null, contextWindow: null, rateLimits: null, effort: level, outputStyle: null, sessionName: null, linesAdded: null, linesRemoved: null, totalDurationMs: null, pr: null };
    return this.storeComposerOption(sessionId, { cliStatus: next as unknown as Record<string, unknown> });
  }

  /** Launch option changed from the composer (or reported by the CLI): written without touching the activity time. */
  private async storeComposerOption(sessionId: string, patch: Pick<Partial<typeof sessions.$inferInsert>, 'permissionMode' | 'model' | 'effort' | 'cliStatus'>): Promise<SessionRow> {
    const [row] = await this.deps.db.update(sessions).set(patch).where(this.ownSession(sessionId)).returning();
    if (!row) throw new RunnerError('NOT_FOUND', 'Session introuvable.');
    await this.publishStatus(row);
    return row;
  }

  /**
   * Live session the composer may drive right now, or null when no CLI runs (the option is then
   * stored for the next start or resumption). Never during a permission request: Maj+Tab or a
   * typed command would answer the CLI's dialog.
   */
  private async composerLive(sessionId: string): Promise<LiveSession | null> {
    const live = this.live.get(sessionId);
    if (!live) {
      const row = await this.row(sessionId);
      if (row.status === 'archived') throw new RunnerError('CONFLICT', 'Session archivée.', { reason: 'SESSION_NOT_RESUMABLE', untouched: "Rien n'a été modifié." });
      if (this.launching.has(sessionId)) {
        throw new RunnerError('CONFLICT', 'Claude Code démarre : réessayez dans un instant.', { reason: 'SESSION_NOT_LIVE', untouched: "Rien n'a été modifié." });
      }
      return null;
    }
    if (live.stopping) throw new RunnerError('CONFLICT', "La session est en cours d'arrêt.", { reason: 'SESSION_NOT_LIVE', untouched: "Rien n'a été modifié." });
    if (!live.ready || !live.terminal?.alive) {
      throw new RunnerError('CONFLICT', 'Claude Code démarre : réessayez dans un instant.', { reason: 'SESSION_NOT_LIVE', untouched: "Rien n'a été modifié." });
    }
    if (live.pending.size > 0 || (await this.row(sessionId)).status === 'waiting_permission') {
      throw new RunnerError('CONFLICT', "Répondez d'abord à la demande d'autorisation.", { reason: 'SESSION_BUSY_PERMISSION', untouched: "Rien n'a été modifié." });
    }
    return live;
  }

  /**
   * Composer model chip: `/model <alias>` (allowlisted, see `SESSION_SLASH_COMMANDS`) typed into the
   * idle CLI, confirmed by its « Set model to … » line. Without a live CLI: `--model` of the next
   * launch. The chip itself shows the model of the status line, never this value.
   */
  async runSlashCommand(sessionId: string, command: SessionSlashCommandRequest): Promise<SessionCommandResult> {
    const live = await this.composerLive(sessionId);
    const isModel = command.command === 'model';
    // `--model` / `--effort` of the next launch (`auto`: no --effort, the CLI's default).
    const stored = command.command === 'model' ? { model: command.model } : { effort: command.effort === 'auto' ? null : command.effort };
    const what = isModel ? 'le modèle' : "l'effort";
    const asked = command.command === 'model' ? command.model : command.effort;
    if (!live) {
      await this.storeComposerOption(sessionId, stored);
      return { session: await this.dto(sessionId), applied: 'next_launch' };
    }
    const row = await this.row(sessionId);
    if (row.status === 'running' || live.queue.length > 0) {
      throw new RunnerError('CONFLICT', `Claude travaille : changez ${what} à la fin de l'étape en cours.`, {
        reason: 'SESSION_BUSY',
        untouched: isModel ? "Le modèle n'a pas changé." : "L'effort n'a pas changé.",
      });
    }
    const terminal = live.terminal!;
    // The CLI's own confirmation: « Set model to … », « Set effort level to high… », « Effort level: auto ».
    const confirmation = isModel ? /set model to/gi : /set effort level to|effort level: auto/gi;
    const before = (terminal.screenText().match(confirmation) ?? []).length;
    let output = '';
    const off = terminal.onOutput((data) => {
      output = (output + data).slice(-20_000);
    });
    let outcome: 'confirmed' | 'picker' | null = null;
    try {
      await this.paste(live, slashCommandText(command));
      const deadline = Date.now() + MODEL_CONFIRM_MS;
      while (Date.now() < deadline && !outcome) {
        await new Promise((r) => setTimeout(r, 100));
        const screen = terminal.screenText();
        const plain = output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
        if ((screen.match(confirmation) ?? []).length > before || new RegExp(confirmation.source, 'i').test(plain)) outcome = 'confirmed';
        else if (isModel && /select model/i.test(screen)) outcome = 'picker';
      }
    } finally {
      off();
    }
    if (outcome === 'picker') {
      terminal.write('\u001b');
      throw new RunnerError('CONFLICT', `Le CLI a ouvert son sélecteur de modèle au lieu d'appliquer « ${asked} » : il a été refermé.`, {
        reason: 'MODEL_UNCONFIRMED',
        untouched: "Le modèle n'a pas changé.",
      });
    }
    if (outcome !== 'confirmed') {
      throw new RunnerError('CONFLICT', `Le CLI n'a pas confirmé ${what} « ${asked} » : vérifiez dans le terminal de la session.`, {
        reason: isModel ? 'MODEL_UNCONFIRMED' : 'EFFORT_UNCONFIRMED',
      });
    }
    await this.storeComposerOption(sessionId, stored);
    if (command.command === 'effort') {
      // Confirmed on the CLI's screen: that is the effort it now runs with (`auto`: unknown until it reports one).
      const level = command.effort === 'auto' ? null : command.effort;
      if (level) this.reportedEfforts.set(sessionId, level);
      else this.reportedEfforts.delete(sessionId);
      await this.storeReportedEffort(sessionId, level);
    }
    return { session: await this.dto(sessionId), applied: 'live' };
  }

  /**
   * Composer mode chip: Maj+Tab (`ESC [ Z`, the CLI's own key) until its screen shows the mode, at
   * most {@link MAX_MODE_PRESSES} presses and never past a full cycle. Without a live CLI:
   * `--permission-mode` of the next launch. Typed one at a time with the instructions.
   */
  async switchPermissionMode(sessionId: string, target: SwitchablePermissionMode): Promise<PermissionModeResult> {
    const live = await this.composerLive(sessionId);
    if (!live) {
      const row = await this.storeComposerOption(sessionId, { permissionMode: target });
      return { session: await this.dto(row), applied: 'next_launch', presses: 0, mode: row.permissionMode };
    }
    const run = live.typing.then(() => this.cycleMode(live, target));
    live.typing = run.then(
      () => undefined,
      () => undefined,
    );
    const { presses, current } = await run;
    if (current) {
      this.reportedModes.set(sessionId, current);
      await this.storeComposerOption(sessionId, { permissionMode: current });
    }
    if (current !== target) {
      const shown = current ? ` : il est en « ${MODE_LABELS[current]} »` : '';
      throw new RunnerError('CONFLICT', `Le CLI ne propose pas le mode « ${MODE_LABELS[target]} » dans cette session${shown}.`, {
        reason: 'PERMISSION_MODE_UNAVAILABLE',
        data: { presses, mode: current },
      });
    }
    return { session: await this.dto(sessionId), applied: 'live', presses, mode: current };
  }

  private async cycleMode(live: LiveSession, target: SwitchablePermissionMode): Promise<{ presses: number; current: SessionRow['permissionMode'] | null }> {
    const terminal = live.terminal;
    if (!terminal?.alive) throw new RunnerError('CONFLICT', 'Le terminal de la session est fermé.', { reason: 'SESSION_NOT_LIVE' });
    let current = detectPermissionMode(terminal.screenText());
    const start = current;
    let presses = 0;
    while (current !== target && presses < MAX_MODE_PRESSES && terminal.alive) {
      terminal.write('\u001b[Z');
      presses += 1;
      await this.waitQuiet(terminal, 300, 2500);
      current = detectPermissionMode(terminal.screenText());
      if (presses > 1 && start !== null && current === start) break;
    }
    return { presses, current };
  }

  // -------------------------------------------------------------------------------------------
  // Permission decisions (Nuera UI)
  // -------------------------------------------------------------------------------------------

  async decide(
    permissionId: string,
    input: { behavior: 'allow' | 'deny'; always: boolean; message?: string; decidedByUserId?: string | null },
  ): Promise<PermissionRequestDto> {
    // Scoped through its session BEFORE any write: another server's request is « introuvable ».
    const row = await getPermissionRow(this.deps.db, this.envId, permissionId);
    if (row.status !== 'pending') {
      throw new RunnerError('CONFLICT', 'Cette demande a déjà reçu une réponse.', { reason: 'PERMISSION_NOT_PENDING', data: { status: row.status } });
    }
    const live = this.live.get(row.sessionId);
    const pending = live?.pending.get(permissionId);
    if (!live || !pending) {
      await this.deps.db.update(permissionRequests).set({ status: 'answered_in_terminal' }).where(eq(permissionRequests.id, permissionId));
      throw new RunnerError('CONFLICT', "La demande n'attend plus de réponse ici : répondez dans le terminal.", { reason: 'PERMISSION_NO_LISTENER' });
    }
    const suggestions = Array.isArray(row.suggestions) ? row.suggestions : [];
    const status = input.behavior === 'deny' ? 'denied' : input.always && suggestions.length ? 'allowed_always' : 'allowed';
    const message = input.behavior === 'deny' ? (input.message?.trim() || DEFAULT_DENY_MESSAGE) : null;
    const output: HookDecisionOutput = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision:
          input.behavior === 'deny'
            ? { behavior: 'deny', message: message! }
            : status === 'allowed_always'
              ? { behavior: 'allow', updatedPermissions: suggestions }
              : { behavior: 'allow' },
      },
    };
    clearTimeout(pending.timer);
    live.pending.delete(permissionId);
    const updated = await this.deps.store.queue.run(row.sessionId, async () => {
      const [u] = await this.deps.db
        .update(permissionRequests)
        .set({ status, decidedAt: new Date(), decidedByUserId: input.decidedByUserId ?? null, decisionMessage: message })
        .where(eq(permissionRequests.id, permissionId))
        .returning();
      await this.afterPermissionResolved(live, u!);
      return u!;
    });
    pending.resolve(output);
    return this.permissionDto(updated, live.cwd);
  }

  private async afterPermissionResolved(live: LiveSession, row: PermissionRow): Promise<void> {
    const key = `permission:${row.id}`;
    if (await this.deps.store.find(live.id, key)) {
      await this.deps.store.update<'permission'>(live.id, key, (p) => ({
        ...p,
        status: row.status,
        resolvedLabel: resolvedLabel(row.toolName, row.status, row.target),
        decidedAt: row.decidedAt ? row.decidedAt.toISOString() : nowIso(),
      }));
    }
    if (row.status === 'denied') await this.markToolDenied(live, row.id);
    this.deps.bus.publish('session.permission', { sessionId: live.id, permission: this.permissionDto(row, live.cwd) }, { channels: [GLOBAL, sessionChannel(live.id)] });
    const stillPending = live.pending.size > 0;
    if (row.status === 'answered_in_terminal') {
      await this.setSession(live.id, { status: 'waiting_permission', currentActivity: 'Répondez à la demande dans le terminal' });
    } else if (!stillPending) {
      await this.setSession(live.id, { status: 'running', currentActivity: null });
    }
  }

  private async markToolDenied(live: LiveSession, permissionId: string): Promise<void> {
    const tools = await this.deps.store.recent(live.id, 'tool', 20);
    const item = tools.find((t) => t.kind === 'tool' && t.payload.permissionId === permissionId);
    if (item?.key) {
      await this.deps.store.update<'tool'>(live.id, item.key, (p) => ({ ...p, status: 'denied', summary: toolSummary('denied', null), finishedAt: nowIso() }));
    }
  }

  // -------------------------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------------------------

  /** Authenticates a hook call (per-session token, constant-time). */
  authenticate(sessionId: string, token: string | null): LiveSession | null {
    if (!token) return null;
    const live = this.live.get(sessionId);
    if (!live) return null;
    return tokenMatches(token, live.tokenHash) ? live : null;
  }

  /**
   * Entry point of `bin/nuera-hook.mjs`. Returns the JSON to print (PermissionRequest decision)
   * or null (print nothing). Events of a session are processed one at a time, in order.
   */
  async handleHook(live: LiveSession, payload: Json, signal: AbortSignal): Promise<HookDecisionOutput | null> {
    const event = str(payload.hook_event_name) ?? '';
    // Noted on receipt (before queueing): an interrupt is settled only when nothing followed it.
    if (event === 'PermissionRequest' || isActivityHook(event, payload)) live.lastActiveAt = Date.now();
    void this.noteReportedMode(live, payload);
    void this.noteReportedEffort(live, payload);
    if (event === 'PermissionRequest') return this.onPermissionRequest(live, payload, signal);
    await this.deps.store.queue.run(live.id, () => this.onEvent(live, event, payload));
    return null;
  }

  private async onEvent(live: LiveSession, event: string, p: Json): Promise<void> {
    if (this.live.get(live.id) !== live) return;
    switch (event) {
      case 'SessionStart':
        return this.onSessionStart(live, p);
      case 'UserPromptSubmit':
        return this.onPrompt(live, p);
      case 'PreToolUse':
        return this.onPreTool(live, p);
      case 'PostToolUse':
      case 'PostToolUseFailure':
        return this.onPostTool(live, p, event === 'PostToolUseFailure');
      case 'Notification':
        return this.onNotification(live, p);
      case 'Stop':
        return this.onStop(live, p);
      case 'StopFailure':
        return this.onStopFailure(live, p);
      case 'SubagentStart':
      case 'SubagentStop':
        return this.onSubagent(live, p, event === 'SubagentStop');
      case 'PreCompact':
      case 'PostCompact':
        return this.onCompact(live, p, event === 'PostCompact');
      case 'SessionEnd':
        if (str(p.reason) !== 'clear') live.sessionEnded = true;
        return;
      default:
        return;
    }
  }

  /** Callers of {@link drainTranscript} already hold the session queue; the tailer's timer takes it. */
  private newTailer(live: LiveSession, transcript: string, fromEnd: boolean): TranscriptTailer {
    return new TranscriptTailer(transcript, (t) => this.onTranscriptText(live, t), {
      fromEnd,
      runExclusive: (task) => this.deps.store.queue.run(live.id, task),
    });
  }

  private async drainTranscript(live: LiveSession): Promise<void> {
    await live.tailer?.drain().catch(() => undefined);
  }

  private async onTranscriptText(live: LiveSession, item: TranscriptText): Promise<void> {
    if (await this.deps.store.find(live.id, item.key)) return;
    const recent = await this.deps.store.recent(live.id, 'assistant', 5);
    const text = redactSecrets(item.text);
    if (recent.some((r) => r.kind === 'assistant' && normalizeText(r.payload.text) === normalizeText(text))) return;
    await this.deps.store.append(live.id, 'assistant', { text, at: item.at, source: 'transcript', final: false }, item.key);
    // The CLI's own message (not the model's): « 5-hour limit reached ∙ resets 3pm ».
    if (item.cliMessage) {
      const found = detectLimitText(item.text);
      if (found) await this.recordLimit(live, 'transcript', found);
    }
  }

  private async onSessionStart(live: LiveSession, p: Json): Promise<void> {
    const source = str(p.source) ?? 'startup';
    const transcript = await validateTranscriptPath(p.transcript_path, this.transcriptRoot(live));
    const claudeId = str(p.session_id);
    const bridge = str(p.nuera_bridge_session_id);
    const patch: Partial<typeof sessions.$inferInsert> = {};
    if (transcript) {
      patch.transcriptPath = transcript;
      if (!live.tailer || live.tailer.file !== transcript) {
        live.tailer?.stop();
        live.tailer = this.newTailer(live, transcript, source === 'resume');
        live.tailer.start();
      }
    }
    if (claudeId && /^[0-9a-f-]{36}$/i.test(claudeId)) {
      patch.claudeSessionId = claudeId;
      await updateLaunchFile(this.deps.dataDir, live.id, { claudeSessionId: claudeId });
    }
    if (bridge && /^session_[A-Za-z0-9_-]{4,128}$/.test(bridge)) patch.remoteControlUrl = `https://claude.ai/code/${bridge}`;
    if (source === 'clear') {
      await this.deps.store.append(live.id, 'system', { message: 'Nouvelle conversation (/clear)', at: nowIso() });
    }
    const wasReady = live.ready;
    live.ready = true;
    if (live.readyTimer) clearTimeout(live.readyTimer);
    const row = await this.row(live.id);
    const status: SessionStatus = live.queue.length > 0 ? 'running' : row.status === 'waiting_permission' ? row.status : row.status === 'new' ? 'new' : 'waiting_input';
    await this.setSession(live.id, { ...patch, status, currentActivity: null });
    if (!wasReady && live.queue.length > 0) void this.deliverQueue(live);
  }

  private async onPrompt(live: LiveSession, p: Json): Promise<void> {
    const prompt = str(p.prompt);
    if (prompt === null) return;
    await this.drainTranscript(live);
    live.turn += 1;
    const normalized = normalizeText(prompt);
    const fromNuera = live.pasted.findIndex((x) => normalizeText(x.text) === normalized);
    if (fromNuera !== -1) live.pasted.splice(fromNuera, 1);
    const promptId = str(p.prompt_id);
    // Typed by an automatic resumption: the limit record stays (attempts count); any other prompt
    // (Nuera Dev, raw terminal) is the owner taking over and cancels the schedule.
    const auto = this.autoPrompts.get(live.id);
    const isAuto = auto !== undefined && normalizeText(auto) === normalized;
    if (isAuto) this.autoPrompts.delete(live.id);
    else this.clearResumeTimer(live.id);
    await this.deps.store.append(
      live.id,
      'instruction',
      { text: redactSecrets(prompt).slice(0, 100_000), source: fromNuera !== -1 ? 'nuera' : 'terminal', at: nowIso() },
      promptId ? `instruction:${promptId}` : null,
    );
    await this.setSession(live.id, {
      status: 'running',
      lastInstruction: prompt.slice(0, 2000),
      currentActivity: null,
      errorCode: null,
      errorMessage: null,
      ...(isAuto ? {} : { usageLimit: null }),
    });
  }

  private toolKey(live: LiveSession, p: Json): string {
    const id = str(p.tool_use_id);
    if (id) return `tool:${id}`;
    live.toolSeq += 1;
    return `tool:seq:${live.toolSeq}`;
  }

  private async onPreTool(live: LiveSession, p: Json): Promise<void> {
    const tool = str(p.tool_name);
    if (!tool) return;
    await this.drainTranscript(live);
    const row = await this.row(live.id);
    if (tool === 'TodoWrite') {
      await this.updatePlan(live, p.tool_input);
      if (row.status === 'waiting_permission' && live.pending.size === 0) await this.setSession(live.id, { status: 'running' });
      return;
    }
    const key = this.toolKey(live, p);
    const existing = await this.deps.store.find(live.id, key);
    if (!existing) {
      await this.deps.store.append(
        live.id,
        'tool',
        {
          toolUseId: str(p.tool_use_id),
          tool,
          target: toolTarget(tool, p.tool_input, live.cwd),
          status: 'running',
          meta: null,
          summary: toolSummary('running', null),
          output: null,
          outputTruncated: false,
          error: null,
          permissionId: null,
          subagent: str(p.agent_type),
          startedAt: nowIso(),
          finishedAt: null,
        },
        key,
      );
    }
    const target = toolTarget(tool, p.tool_input, live.cwd);
    const verb = activityVerbs[tool] ?? `Utilise ${tool}`;
    await this.setSession(live.id, {
      status: live.pending.size > 0 ? 'waiting_permission' : 'running',
      currentActivity: live.planCurrent ?? (target ? `${verb} ${target}`.slice(0, 300) : verb),
    });
  }

  private async updatePlan(live: LiveSession, input: unknown): Promise<void> {
    const items = planFromTodoWrite(input);
    if (!items) return;
    const done = items.filter((i) => i.status === 'completed').length;
    const currentItem = items.find((i) => i.status === 'in_progress');
    const current = currentItem ? (currentItem.activeForm ?? currentItem.content) : null;
    const key = `plan:${live.turn}`;
    live.planCurrent = current;
    const payload = { items, done, total: items.length, current, at: nowIso() };
    if (await this.deps.store.find(live.id, key)) await this.deps.store.update<'plan'>(live.id, key, () => payload);
    else await this.deps.store.append(live.id, 'plan', payload, key);
    await this.setSession(live.id, { planDone: done, planTotal: items.length, currentActivity: current });
  }

  private async onPostTool(live: LiveSession, p: Json, failed: boolean): Promise<void> {
    const tool = str(p.tool_name);
    if (!tool) return;
    await this.drainTranscript(live);
    if (tool === 'TodoWrite') {
      if (!failed) await this.updatePlan(live, p.tool_input);
      return;
    }
    const key = this.toolKey(live, p);
    const errorText = failed ? (str(p.error) ?? (isObj(p.error) ? JSON.stringify(p.error) : 'échec')) : null;
    const outcome = toolOutcome(tool, p.tool_input, p.tool_response, num(p.duration_ms), errorText);
    const status: 'done' | 'error' = failed ? 'error' : 'done';
    const patch = {
      status,
      meta: outcome.meta,
      // `is_interrupt`: the failure reached Claude Code as an abort, not as an error of the tool.
      summary: failed && p.is_interrupt === true ? 'interrompu' : toolSummary(status, outcome.meta),
      output: outcome.output,
      outputTruncated: outcome.outputTruncated,
      error: errorText ? capText(redactSecrets(errorText), 4000).text : null,
      finishedAt: nowIso(),
    };
    if (await this.deps.store.find(live.id, key)) {
      await this.deps.store.update<'tool'>(live.id, key, (prev) => (prev.status === 'denied' ? prev : { ...prev, ...patch }));
    } else {
      await this.deps.store.append(
        live.id,
        'tool',
        {
          toolUseId: str(p.tool_use_id),
          tool,
          target: toolTarget(tool, p.tool_input, live.cwd),
          permissionId: null,
          subagent: str(p.agent_type),
          startedAt: nowIso(),
          ...patch,
        },
        key,
      );
    }
    const row = await this.row(live.id);
    if (row.status === 'waiting_permission' && live.pending.size === 0) {
      await this.deps.db.update(permissionRequests).set({ status: 'answered_in_terminal' }).where(and(eq(permissionRequests.sessionId, live.id), eq(permissionRequests.status, 'pending')));
      await this.setSession(live.id, { status: 'running', currentActivity: null });
    }
  }

  private async onNotification(live: LiveSession, p: Json): Promise<void> {
    const type = str(p.notification_type);
    const message = str(p.message) ?? '';
    if (type === 'permission_prompt') {
      if (live.pending.size === 0) {
        await this.setSession(live.id, { status: 'waiting_permission', currentActivity: 'Autorisation demandée dans le terminal' });
      }
      return;
    }
    if (type === 'idle_prompt' || !message) return;
    await this.deps.store.append(live.id, 'notification', { notificationType: type, title: str(p.title), message: redactSecrets(message).slice(0, 4000), at: nowIso() });
    if (type === 'auth_success') this.deps.onAuthProblem(live.account);
  }

  private async onStop(live: LiveSession, p: Json): Promise<void> {
    await this.drainTranscript(live);
    const message = str(p.last_assistant_message);
    // Some CLI versions end the turn with the limit message itself (no StopFailure): only a message
    // that IS the limit notice counts, never a reply that merely talks about limits.
    const limitText = message && message.trim().length < 400 ? detectLimitText(message) : null;
    const limitStop = limitText && message!.trim().toLowerCase().startsWith(limitText.message.slice(0, 12).toLowerCase()) ? limitText : null;
    if (message?.trim()) {
      const text = redactSecrets(message.trim());
      const recent = await this.deps.store.recent(live.id, 'assistant', 5);
      const dup = recent.find((r) => r.kind === 'assistant' && normalizeText(r.payload.text) === normalizeText(text));
      if (dup?.key) {
        await this.deps.store.update<'assistant'>(live.id, dup.key, (prev) => ({ ...prev, final: true }));
      } else if (!dup) {
        await this.deps.store.append(live.id, 'assistant', { text, at: nowIso(), source: 'stop', final: true }, `assistant:stop:${live.turn}`);
      }
    }
    // Claude finished responding: no tool of this turn is still running.
    await this.closeRunningTools(live, 'turn_end');
    if (limitStop) {
      await this.setSession(live.id, { status: 'waiting_input', currentActivity: null });
      await this.recordLimit(live, 'hook', limitStop);
      return;
    }
    const before = parseUsageLimit((await this.row(live.id)).usageLimit);
    // A turn that ended normally after an automatic resumption: the limit is behind us.
    const clear = before && !before.active ? { usageLimit: null } : {};
    const row = await this.setSession(live.id, { status: 'waiting_input', currentActivity: null, ...clear });
    void this.notify(live, {
      kind: 'session_finished',
      severity: 'success',
      title: `Claude a terminé : ${row.title}`,
      body: message ? message.slice(0, 200) : null,
      dedupKey: `session:${live.id}:turn:${live.turn}`,
    });
  }

  private async onStopFailure(live: LiveSession, p: Json): Promise<void> {
    const code = str(p.error) ?? 'unknown';
    const detailRaw = p.error_details ?? p.error_message ?? null;
    const detail = typeof detailRaw === 'string' ? detailRaw : detailRaw ? JSON.stringify(detailRaw) : null;
    const message = STOP_FAILURE_MESSAGES[code] ?? STOP_FAILURE_MESSAGES.unknown!;
    await this.deps.store.append(live.id, 'error', { code, message, detail: detail ? redactSecrets(detail).slice(0, 4000) : null, at: nowIso() });
    await this.closeRunningTools(live, 'turn_end');
    if (code === 'rate_limit') {
      await this.drainTranscript(live);
      await this.setSession(live.id, { status: 'waiting_input', currentActivity: null });
      // The reset time: the hook's details, else what the CLI printed on screen (status line first, in recordLimit).
      const found = detectLimitText(detail) ?? detectLimitText(live.terminal?.screenText() ?? null);
      await this.recordLimit(live, 'hook', {
        message: found?.message ?? (detail ? redactSecrets(detail).slice(0, 300) : null) ?? '',
        resetsAt: found?.resetsAt ?? null,
        window: found?.window ?? null,
      });
      return;
    }
    const row = await this.setSession(live.id, { status: 'waiting_input', currentActivity: null, errorCode: code, errorMessage: message });
    if (AUTH_ERRORS.has(code)) {
      this.deps.onAuthProblem(live.account);
      void this.notify(live, { kind: 'claude_disconnected', severity: 'danger', title: message, body: row.title, dedupKey: 'claude:auth' });
    } else {
      void this.notify(live, { kind: 'session_failed', severity: 'warning', title: `${row.title} : ${message}`, body: null, dedupKey: `session:${live.id}:error:${code}` });
    }
  }

  private async onSubagent(live: LiveSession, p: Json, done: boolean): Promise<void> {
    const agentId = str(p.agent_id);
    const key = agentId ? `subagent:${agentId}` : null;
    const payload = {
      agentId,
      agentType: str(p.agent_type),
      status: done ? ('done' as const) : ('running' as const),
      lastMessage: done && str(p.last_assistant_message) ? redactSecrets(str(p.last_assistant_message)!).slice(0, 4000) : null,
      at: nowIso(),
    };
    if (key && (await this.deps.store.find(live.id, key))) await this.deps.store.update<'subagent'>(live.id, key, (prev) => ({ ...prev, ...payload, agentType: payload.agentType ?? prev.agentType }));
    else await this.deps.store.append(live.id, 'subagent', payload, key);
  }

  private async onCompact(live: LiveSession, p: Json, done: boolean): Promise<void> {
    const key = `compact:${live.turn}`;
    const summary = str(p.compact_summary);
    const payload = {
      trigger: str(p.trigger),
      phase: done ? ('done' as const) : ('start' as const),
      summary: summary ? redactSecrets(summary).slice(0, 4000) : null,
      at: nowIso(),
    };
    if (await this.deps.store.find(live.id, key)) await this.deps.store.update<'compact'>(live.id, key, (prev) => ({ ...prev, ...payload, trigger: payload.trigger ?? prev.trigger }));
    else await this.deps.store.append(live.id, 'compact', payload, key);
    if (!done) await this.setSession(live.id, { currentActivity: 'Compacte la conversation…' });
  }

  private async onPermissionRequest(live: LiveSession, p: Json, signal: AbortSignal): Promise<HookDecisionOutput | null> {
    const tool = str(p.tool_name) ?? 'outil';
    const id = randomUUID();
    const suggestions = Array.isArray(p.permission_suggestions) ? (p.permission_suggestions as unknown[]) : null;
    const target = permissionTarget(tool, p.tool_input, live.cwd);
    const expiresAt = new Date(Date.now() + live.permissionWaitSeconds * 1000);
    const created = await this.deps.store.queue.run(live.id, async () => {
      await this.drainTranscript(live);
      const [row] = await this.deps.db
        .insert(permissionRequests)
        .values({
          id,
          sessionId: live.id,
          toolName: tool,
          toolInput: trimToolInput(p.tool_input),
          title: permissionTitle(tool),
          target,
          detail: permissionDetail(tool, p.tool_input),
          suggestions,
          status: 'pending',
          expiresAt,
        })
        .returning();
      // Link the running tool line (PermissionRequest carries no tool_use_id).
      const tools = await this.deps.store.recent(live.id, 'tool', 10);
      const running = tools.find((t) => t.kind === 'tool' && t.payload.status === 'running' && t.payload.tool === tool && !t.payload.permissionId);
      if (running?.key) await this.deps.store.update<'tool'>(live.id, running.key, (prev) => ({ ...prev, permissionId: id }));
      const dto = this.permissionDto(row!, live.cwd);
      await this.deps.store.append(
        live.id,
        'permission',
        {
          permissionId: id,
          tool,
          title: dto.title,
          target: dto.target,
          detail: dto.detail,
          status: 'pending',
          options: dto.options,
          resolvedLabel: null,
          at: nowIso(),
          decidedAt: null,
        },
        `permission:${id}`,
      );
      return dto;
    });
    const decision = new Promise<HookDecisionOutput | null>((resolve) => {
      const timer = setTimeout(() => {
        live.pending.delete(id);
        resolve(null);
        void this.deps.store.queue.run(live.id, async () => {
          const [u] = await this.deps.db
            .update(permissionRequests)
            .set({ status: 'answered_in_terminal' })
            .where(and(eq(permissionRequests.id, id), eq(permissionRequests.status, 'pending')))
            .returning();
          if (u && this.live.get(live.id) === live) await this.afterPermissionResolved(live, u);
        });
      }, live.permissionWaitSeconds * 1000);
      timer.unref?.();
      live.pending.set(id, { id, resolve, timer });
    });
    signal.addEventListener(
      'abort',
      () => {
        const pending = live.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        live.pending.delete(id);
        pending.resolve(null);
        void this.deps.store.queue.run(live.id, async () => {
          const [u] = await this.deps.db
            .update(permissionRequests)
            .set({ status: 'answered_in_terminal' })
            .where(and(eq(permissionRequests.id, id), eq(permissionRequests.status, 'pending')))
            .returning();
          if (u && this.live.get(live.id) === live) await this.afterPermissionResolved(live, u);
        });
      },
      { once: true },
    );
    await this.deps.store.queue.run(live.id, async () => {
      await this.setSession(live.id, { status: 'waiting_permission', currentActivity: 'En attente de votre autorisation' });
      this.deps.bus.publish('session.permission', { sessionId: live.id, permission: created }, { channels: [GLOBAL, sessionChannel(live.id)] });
    });
    void this.notifyPermission(live, created);
    return decision;
  }

  // -------------------------------------------------------------------------------------------
  // Usage limit of the subscription and automatic resumption
  // -------------------------------------------------------------------------------------------

  /** « Reprise automatique » of a session, from its launch options (absent: off). */
  private async autoResumeOptions(sessionId: string): Promise<Required<AutoResumeOptions>> {
    const launch = await readLaunchFile(this.deps.dataDir, sessionId);
    return {
      enabled: launch?.autoResume?.enabled ?? false,
      instruction: launch?.autoResume?.instruction?.trim() || DEFAULT_AUTO_RESUME_INSTRUCTION,
    };
  }

  /**
   * The session stopped on the usage limit (caller holds the session queue). Reset time: the status
   * line's when it is ahead (exact), else the one written in the CLI's message, else unknown.
   */
  private async recordLimit(live: LiveSession, source: UsageLimitSource, found: LimitText): Promise<void> {
    const row = await this.row(live.id);
    const previous = parseUsageLimit(row.usageLimit);
    const options = await this.autoResumeOptions(live.id);
    const cli = live.pendingCli ?? parseCli(row.cliStatus);
    const resetsAt = resolveReset(cli, found);
    const limit = buildUsageLimit({
      previous,
      source,
      message: found.message ? redactSecrets(found.message).slice(0, 300) : null,
      resetsAt,
      window: found.window,
      autoResumeEnabled: options.enabled,
      policy: this.policy,
    });
    const message = usageLimitMessage(limit);
    const updated = await this.setSession(live.id, {
      usageLimit: limit as unknown as Record<string, unknown>,
      // The notice ends the turn (the transcript may show it before the StopFailure hook arrives).
      ...(row.status === 'running' && live.pending.size === 0 ? { status: 'waiting_input' as const } : {}),
      errorCode: 'rate_limit',
      errorMessage: message,
      currentActivity: null,
    });
    this.armAutoResume(live.id, limit);
    if (!previous?.active) {
      void this.notify(live, {
        kind: 'session_usage_limit',
        severity: 'warning',
        title: `${updated.title} : limite d'utilisation atteinte`,
        body: message,
        dedupKey: `session:${live.id}:limit:${limit.detectedAt}`,
      });
    }
  }

  private clearResumeTimer(sessionId: string): void {
    const timer = this.resumeTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.resumeTimers.delete(sessionId);
  }

  /** No limit in play any more (the owner took over, stopped the session): record and timer dropped. */
  private async clearUsageLimit(sessionId: string): Promise<void> {
    this.clearResumeTimer(sessionId);
    this.autoPrompts.delete(sessionId);
    const [row] = await this.deps.db
      .update(sessions)
      .set({
        usageLimit: null,
        // The limit line goes with it; any other error stays.
        errorCode: sql`case when ${sessions.errorCode} = 'rate_limit' then null else ${sessions.errorCode} end`,
        errorMessage: sql`case when ${sessions.errorCode} = 'rate_limit' then null else ${sessions.errorMessage} end`,
      })
      .where(and(this.ownSession(sessionId), sql`${sessions.usageLimit} is not null`))
      .returning();
    if (row) await this.publishStatus(row);
  }

  /** Arms (or re-arms) the timer of a scheduled resumption; anything else clears it. */
  private armAutoResume(sessionId: string, limit: UsageLimit | null): void {
    this.clearResumeTimer(sessionId);
    const next = limit?.active && limit.autoResume?.outcome === 'scheduled' ? limit.autoResume.nextAttemptAt : null;
    if (!next) return;
    const delay = Math.min(Math.max(0, Date.parse(next) - Date.now()), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      this.resumeTimers.delete(sessionId);
      void this.fireAutoResume(sessionId).catch((error: unknown) => this.deps.logger.warn({ err: error, sessionId }, 'reprise automatique impossible'));
    }, delay);
    timer.unref?.();
    this.resumeTimers.set(sessionId, timer);
  }

  private async writeLimit(sessionId: string, limit: UsageLimit | null, extra: Partial<typeof sessions.$inferInsert> = {}): Promise<SessionRow> {
    return this.deps.store.queue.run(sessionId, () =>
      this.setSession(sessionId, { usageLimit: limit as unknown as Record<string, unknown> | null, ...extra }),
    );
  }

  /**
   * Time of a scheduled resumption: types the instruction into the live CLI, or resumes the
   * conversation (`claude --resume`) when the CLI is gone. Nothing happens if the owner took over,
   * stopped or archived the session, or turned the option off meanwhile.
   */
  async fireAutoResume(sessionId: string): Promise<void> {
    let row: SessionRow;
    try {
      row = await this.row(sessionId);
    } catch {
      return;
    }
    const limit = parseUsageLimit(row.usageLimit);
    const resume = limit?.autoResume;
    if (!limit?.active || !resume || resume.outcome !== 'scheduled' || !resume.nextAttemptAt) return;
    if (Date.parse(resume.nextAttemptAt) - Date.now() > 1000) {
      this.armAutoResume(sessionId, limit);
      return;
    }
    if (row.status === 'archived' || row.archivedAt) {
      await this.writeLimit(sessionId, null);
      return;
    }
    const options = await this.autoResumeOptions(sessionId);
    if (!options.enabled) {
      await this.writeLimit(sessionId, { ...limit, autoResume: { ...resume, enabled: false, nextAttemptAt: null, outcome: 'off' } });
      return;
    }
    const live = this.live.get(sessionId);
    const retryLater = async (reason: string) => {
      const next = { ...resume, nextAttemptAt: new Date(Date.now() + AUTO_RESUME_BUSY_RETRY_MS).toISOString(), lastError: reason };
      const updated = { ...limit, autoResume: next };
      await this.writeLimit(sessionId, updated, { errorMessage: usageLimitMessage(updated) });
      this.armAutoResume(sessionId, updated);
    };
    if (live && (live.pending.size > 0 || row.status === 'waiting_permission')) {
      await retryLater("Une demande d'autorisation attend une réponse.");
      return;
    }
    const attempt = resume.attempts + 1;
    const fired: UsageLimit = {
      ...limit,
      active: false,
      autoResume: { ...resume, attempts: attempt, lastAttemptAt: nowIso(), nextAttemptAt: null, outcome: 'fired', lastError: null },
    };
    // Written before typing: a restart in between never fires twice.
    await this.deps.store.queue.run(sessionId, async () => {
      await this.deps.store.append(sessionId, 'system', {
        message: `Reprise automatique après la limite d'utilisation (tentative ${attempt} sur ${resume.maxAttempts})`,
        at: nowIso(),
      });
      await this.setSession(sessionId, { usageLimit: fired as unknown as Record<string, unknown>, errorCode: null, errorMessage: null });
    });
    this.autoPrompts.set(sessionId, options.instruction);
    try {
      if (this.isActive(sessionId)) await this.launch(sessionId, { resume: false, queue: [options.instruction] });
      else await this.resume(sessionId, undefined, [options.instruction]);
    } catch (error) {
      this.autoPrompts.delete(sessionId);
      const reason = error instanceof RunnerError ? error.message : 'La session ne peut pas reprendre.';
      // Capacity reached, a permission pending, the server suspended, a database hiccup: later.
      // A session that can no longer resume (worktree or conversation gone, CLI missing): never.
      const busy = !(error instanceof RunnerError) || !(error.code === 'NOT_FOUND' || (error.reason && AUTO_RESUME_FINAL_REASONS.has(error.reason)));
      const back: UsageLimit = {
        ...limit,
        autoResume: busy
          ? { ...resume, nextAttemptAt: new Date(Date.now() + AUTO_RESUME_BUSY_RETRY_MS).toISOString(), lastError: reason }
          : { ...resume, attempts: attempt, lastAttemptAt: nowIso(), nextAttemptAt: null, outcome: 'exhausted', lastError: reason },
      };
      await this.writeLimit(sessionId, back, { errorCode: 'rate_limit', errorMessage: usageLimitMessage(back) }).catch(() => undefined);
      this.armAutoResume(sessionId, back);
      this.deps.logger.warn({ err: error, sessionId }, 'reprise automatique non lancée');
      return;
    }
    const target = this.live.get(sessionId);
    const title = (await this.row(sessionId).catch(() => row)).title;
    const payload = {
      kind: 'session_auto_resumed' as const,
      severity: 'success' as const,
      title: 'Session reprise automatiquement',
      body: `${title} · après la limite d'utilisation`,
      dedupKey: `session:${sessionId}:auto-resume:${limit.detectedAt}:${attempt}`,
    };
    if (target) void this.notify(target, payload);
  }

  /**
   * « Reprise automatique après la limite d'utilisation » changed for this session (effective
   * value computed by the web): kept in its launch options, and a limit in play is (re)scheduled or
   * its resumption cancelled.
   */
  async setAutoResume(sessionId: string, input: AutoResumeOptions): Promise<SessionDto> {
    const row = await this.row(sessionId);
    const current = await readLaunchFile(this.deps.dataDir, sessionId);
    const next: AutoResumeOptions = { enabled: input.enabled, ...(input.instruction?.trim() ? { instruction: input.instruction.trim() } : current?.autoResume?.instruction ? { instruction: current.autoResume.instruction } : {}) };
    if (current) await updateLaunchFile(this.deps.dataDir, sessionId, { autoResume: next });
    const limit = parseUsageLimit(row.usageLimit);
    if (limit?.active) {
      const turnedOn = input.enabled && !limit.autoResume?.enabled;
      const autoResume = scheduleAutoResume({
        enabled: input.enabled,
        resetsAt: limit.resetsAt,
        // Turned on by the owner: a fresh count (and a fresh 6-hour window when the reset is unknown).
        detectedAt: turnedOn ? nowIso() : limit.detectedAt,
        carried: turnedOn || !limit.autoResume ? null : { attempts: limit.autoResume.attempts, lastAttemptAt: limit.autoResume.lastAttemptAt, giveUpAt: limit.autoResume.giveUpAt },
        policy: this.policy,
      });
      const updated: UsageLimit = { ...limit, autoResume };
      await this.writeLimit(sessionId, updated, { errorMessage: usageLimitMessage(updated) });
      this.armAutoResume(sessionId, updated);
    }
    return this.dto(sessionId);
  }

  /** Runner start: timers of the resumptions still scheduled on this server. */
  private async restoreAutoResume(): Promise<number> {
    const rows = await this.deps.db
      .select({ id: sessions.id, usageLimit: sessions.usageLimit, status: sessions.status })
      .from(sessions)
      .where(and(eq(sessions.environmentId, this.envId), sql`${sessions.usageLimit} is not null`));
    let armed = 0;
    for (const row of rows) {
      const limit = parseUsageLimit(row.usageLimit);
      if (row.status === 'archived' || !limit?.active || limit.autoResume?.outcome !== 'scheduled') continue;
      this.armAutoResume(row.id, limit);
      armed += 1;
    }
    return armed;
  }

  // -------------------------------------------------------------------------------------------
  // Status line, MCP headers
  // -------------------------------------------------------------------------------------------

  async handleStatusLine(live: LiveSession, payload: unknown): Promise<void> {
    const status = sanitizeStatusLine(payload);
    if (!status) return;
    const fingerprint = statusFingerprint(status);
    if (fingerprint === live.lastCliFingerprint) return;
    live.lastCliFingerprint = fingerprint;
    live.pendingCli = status;
    if (live.cliWriteTimer) return;
    live.cliWriteTimer = setTimeout(() => {
      live.cliWriteTimer = null;
      void this.deps.store.queue.run(live.id, () => this.flushCliStatus(live)).catch(() => undefined);
    }, 1500);
    live.cliWriteTimer.unref?.();
  }

  private async flushCliStatus(live: LiveSession): Promise<void> {
    const status = live.pendingCli;
    live.pendingCli = null;
    if (!status) return;
    const [row] = await this.deps.db
      .update(sessions)
      .set({ cliStatus: status as unknown as Record<string, unknown> })
      .where(this.ownSession(live.id))
      .returning();
    if (!row) return;
    // A limit recorded before the status line told its exact reset time: complete it.
    const limit = parseUsageLimit(row.usageLimit);
    const reset = limit?.active ? resetFromStatus(status, limit.window, Date.now(), { full: true }) : null;
    if (limit && reset && reset !== limit.resetsAt) {
      await this.recordLimit(live, limit.source, { message: limit.message ?? '', resetsAt: reset, window: limit.window });
      return;
    }
    await this.publishStatus(row);
  }

  async mcpHeaders(live: LiveSession, input: { serverName: string; serverUrl: string | null }): Promise<Record<string, string>> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.serverName)) return {};
    const headers = await this.deps.web.mcpHeaders({ sessionId: live.id, projectId: live.projectId, serverName: input.serverName, serverUrl: input.serverUrl });
    if (!headers) return {};
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (/^[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string' && !/[\r\n]/.test(v)) safe[k] = v;
    return safe;
  }

  /** S5 « <titre> attend votre accord » / « <cible> · <projet> · touchez pour répondre », on the request's card. */
  private async notifyPermission(live: LiveSession, permission: PermissionRequestDto): Promise<void> {
    const [names] = await this.deps.db
      .select({ title: sessions.title, project: projects.name })
      .from(sessions)
      .innerJoin(projects, eq(projects.id, sessions.projectId))
      .where(eq(sessions.id, live.id))
      .limit(1)
      .catch(() => []);
    const copy = permissionNotificationCopy({
      sessionTitle: names?.title ?? live.title,
      projectName: names?.project ?? null,
      target: permission.target,
      requestTitle: permission.title,
    });
    await this.notify(live, { kind: 'permission_request', severity: 'warning', ...copy, dedupKey: `permission:${permission.id}` }, { anchor: `demande-${permission.id}` });
  }

  private async notify(
    live: LiveSession,
    payload: Omit<Parameters<WebClient['notify']>[0], 'sessionId' | 'projectId' | 'href'>,
    options: { anchor?: string } = {},
  ): Promise<void> {
    // The session page is the Workspace (`/workspace/[sessionId]`, docs/figma/overview.md route map);
    // a permission request lands on its card (`#demande-<id>`, like « Répondre » of Sessions).
    const href = `/workspace/${live.id}${options.anchor ? `#${options.anchor}` : ''}`;
    const result = await this.deps.web.notify({ ...payload, sessionId: live.id, projectId: live.projectId, href });
    this.deps.bus.publish(
      'notification.created',
      {
        id: result?.id ?? null,
        kind: payload.kind,
        severity: payload.severity,
        title: payload.title,
        body: payload.body ?? null,
        href,
        projectId: live.projectId,
        sessionId: live.id,
      },
      { channels: [GLOBAL] },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Watchdog, reconciliation, shutdown
  // -------------------------------------------------------------------------------------------

  private ensureWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => void this.checkResources(), 15_000);
    this.watchdog.unref?.();
  }

  private async checkResources(): Promise<void> {
    for (const live of this.live.values()) {
      if (!live.pid || !live.memoryLimitMb || live.stopping) continue;
      try {
        const pids = await processTree(live.pid);
        const stats = await pidusage(pids);
        const rss = Object.values(stats).reduce((sum, s) => sum + (s?.memory ?? 0), 0);
        if (rss > live.memoryLimitMb * 1024 * 1024) {
          this.deps.logger.warn({ sessionId: live.id, rss }, 'plafond mémoire dépassé : arrêt de la session');
          live.stopping = 'memory';
          await this.terminate(live, true);
        }
      } catch {
        // process gone between two checks
      }
    }
  }

  /**
   * Runner start: re-attach to live tmux sessions, mark vanished ones `interrupted`
   * (resumable when the worktree and the conversation still exist).
   *
   * Orphan policy for the other `nuera-*` sessions of the tmux socket (a CLI that outlived its row's
   * status, e.g. a crash between the spawn and the status write): a session whose row is known and
   * can still be reached (hook token, worktree free, not archived) is adopted (`waiting_input`);
   * any other one is left running and logged — the runner never kills a tmux session on its own
   * (the owner may be attached to it over SSH, `tmux -L <socket> attach -t <nom>`). A tmux session is
   * only re-attached or adopted when its NUERA_SESSION_ID is the row's id.
   */
  async reconcile(): Promise<{ reattached: number; interrupted: number; adopted: number; orphans: number }> {
    const environmentId = this.envId;
    const rows = await this.deps.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.environmentId, environmentId), inArray(sessions.status, [...LIVE_SESSION_STATUSES])));
    let reattached = 0;
    let interrupted = 0;
    let adopted = 0;
    let orphans = 0;
    const tmux = this.deps.backend instanceof TmuxBackend ? this.deps.backend : null;
    const alive = new Set(tmux ? await tmux.listSessions() : []);
    const tried = new Set<string>();
    for (const row of rows) {
      if (tmux && row.backend === 'tmux' && row.tmuxName && alive.has(row.tmuxName) && row.hookTokenHash && row.worktreeId) {
        tried.add(row.id);
        if (await this.reattachTmux(row, tmux, { adopt: false })) {
          reattached += 1;
          continue;
        }
      }
      await this.deps.db
        .update(permissionRequests)
        .set({ status: 'cancelled', decidedAt: new Date() })
        .where(and(eq(permissionRequests.sessionId, row.id), eq(permissionRequests.status, 'pending')));
      await this.deps.store.queue.run(row.id, async () => {
        await this.deps.store.append(row.id, 'status', { status: 'interrupted', label: 'Session interrompue · reprise possible', at: nowIso() });
        await this.setSession(row.id, { status: 'interrupted', pid: null, endedAt: new Date(), currentActivity: null });
      });
      interrupted += 1;
    }
    if (tmux) {
      const attached = new Set([...this.live.values()].map((l) => l.tmuxName).filter(Boolean));
      for (const name of alive) {
        if (!name.startsWith('nuera-') || attached.has(name)) continue;
        // Only a row of THIS server may be adopted (a socket shared by mistake never crosses servers).
        const [known] = await this.deps.db
          .select()
          .from(sessions)
          .where(and(eq(sessions.tmuxName, name), eq(sessions.environmentId, environmentId)))
          .orderBy(desc(sessions.createdAt))
          .limit(1);
        const adoptable =
          known &&
          !tried.has(known.id) &&
          !this.live.has(known.id) &&
          known.backend === 'tmux' &&
          !known.archivedAt &&
          known.hookTokenHash &&
          known.worktreeId &&
          !this.liveSessionForWorktree(known.worktreeId);
        if (adoptable && (await this.reattachTmux(known, tmux, { adopt: true }))) {
          adopted += 1;
          continue;
        }
        orphans += 1;
        this.deps.logger.warn({ tmuxName: name, sessionId: known?.id ?? null }, 'session tmux orpheline laissée en place');
      }
    }
    if (reattached || adopted) this.ensureWatchdog();
    await this.restoreAutoResume().catch((error: unknown) => this.deps.logger.warn({ err: error }, 'reprises automatiques non relues'));
    return { reattached, interrupted, adopted, orphans };
  }

  /** Attach client + live state for a tmux session that outlived the previous runner process. */
  private async reattachTmux(row: SessionRow, tmux: TmuxBackend, options: { adopt: boolean }): Promise<boolean> {
    if (!row.tmuxName || !row.hookTokenHash || !row.worktreeId) return false;
    const tmuxName = row.tmuxName;
    let terminal: Terminal | null = null;
    try {
      // The tmux session must carry this row's id (NUERA_SESSION_ID, set at start-up): a session of
      // the same name started for another row (another server on a shared socket) is never attached.
      const owner = await tmux.sessionOwner(tmuxName);
      if (owner !== row.id) {
        this.deps.logger.warn({ tmuxName, sessionId: row.id, owner }, "session tmux d'une autre session : jamais rattachée");
        return false;
      }
      const { project, worktree, cwd } = await this.deps.git.resolveWorktree(row.worktreeId);
      const account = await this.deps.accounts.forSpace(project.spaceId);
      const launchFile = await readLaunchFile(this.deps.dataDir, row.id);
      const serverMemory = (await this.deps.environment.settings()).sessionMemoryLimitMb;
      terminal = tmux.attach(tmuxName, { sessionId: row.id, title: row.title, cwd, worktreeId: worktree.id, cols: 120, rows: 36 });
      const live: LiveSession = {
        id: row.id,
        projectId: row.projectId,
        account,
        worktreeId: worktree.id,
        cwd,
        title: row.title,
        backend: 'tmux',
        tmuxName,
        terminal,
        tokenHash: row.hookTokenHash,
        permissionWaitSeconds: launchFile?.permissionWaitSeconds ?? 120,
        memoryLimitMb: tighterLimit(launchFile?.memoryLimitMb, serverMemory),
        ready: true,
        queue: [],
        typing: Promise.resolve(),
        delivering: false,
        lastActiveAt: Date.now(),
        pasted: [],
        pending: new Map(),
        tailer: null,
        turn: 0,
        stopping: null,
        sessionEnded: false,
        pid: null,
        readyTimer: null,
        detachExit: null,
        lastCliFingerprint: '',
        cliWriteTimer: null,
        pendingCli: null,
        toolSeq: 0,
        planCurrent: null,
        launchMode: 'start',
        bootOutput: '',
      };
      live.turn = await this.countTurns(row.id);
      this.live.set(row.id, live);
      this.watchTerminal(live, terminal);
      live.pid = await tmux.pid(terminal, tmuxName);
      if (row.transcriptPath) {
        const transcript = await validateTranscriptPath(row.transcriptPath, this.transcriptRoot(live));
        if (transcript) {
          live.tailer = this.newTailer(live, transcript, true);
          live.tailer.start();
        }
      }
      // Hooks that were waiting on the previous runner process got no answer: the CLI shows its own dialog.
      await this.deps.db
        .update(permissionRequests)
        .set({ status: 'answered_in_terminal' })
        .where(and(eq(permissionRequests.sessionId, row.id), eq(permissionRequests.status, 'pending')));
      if (options.adopt) {
        // The row said « ended » but its CLI is alive: show the truth (the session waits for input).
        await this.deps.store.queue.run(row.id, async () => {
          await this.deps.store.append(row.id, 'status', { status: 'waiting_input', label: 'Session reprise', at: nowIso() });
          await this.setSession(row.id, { status: 'waiting_input', pid: live.pid, endedAt: null, exitCode: null, errorCode: null, errorMessage: null, currentActivity: null });
        });
      } else {
        await this.setSession(row.id, { pid: live.pid, currentActivity: row.status === 'waiting_permission' ? 'Répondez à la demande dans le terminal' : row.currentActivity });
      }
      return true;
    } catch (error) {
      const live = this.live.get(row.id);
      if (live?.terminal === terminal) {
        live?.detachExit?.();
        live?.tailer?.stop();
        this.live.delete(row.id);
      }
      terminal?.kill();
      this.deps.logger.warn({ err: error, sessionId: row.id }, 'réattachement tmux impossible');
      return false;
    }
  }

  /** Runner shutdown: tmux sessions stay alive (attach clients detached), direct PTYs are interrupted. */
  async shutdown(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    // Scheduled resumptions stay in the database: the next runner process re-arms them.
    for (const id of [...this.resumeTimers.keys()]) this.clearResumeTimer(id);
    // eslint-disable-next-line unicorn/no-useless-spread -- snapshot: stopping a session deletes it from this.live
    for (const live of [...this.live.values()]) {
      for (const p of live.pending.values()) {
        clearTimeout(p.timer);
        p.resolve(null);
      }
      live.pending.clear();
      live.tailer?.stop();
      if (live.readyTimer) clearTimeout(live.readyTimer);
      if (live.cliWriteTimer) clearTimeout(live.cliWriteTimer);
      if (live.pendingCli) await this.flushCliStatus(live).catch(() => undefined);
      if (live.backend === 'tmux') {
        live.detachExit?.();
        this.live.delete(live.id);
        live.terminal?.kill();
        continue;
      }
      live.stopping = 'shutdown';
      live.detachExit?.();
      live.terminal?.kill();
      await this.finalize(live, null).catch(() => undefined);
    }
  }
}

/** Linux process tree (pid + descendants) from /proc; other platforms: the pid alone. */
async function processTree(root: number): Promise<number[]> {
  if (process.platform !== 'linux') return [root];
  const { readFile } = await import('node:fs/promises');
  const out: number[] = [];
  const queue = [root];
  while (queue.length && out.length < 512) {
    const pid = queue.shift()!;
    out.push(pid);
    try {
      const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
      for (const c of children.split(/\s+/).filter(Boolean)) queue.push(Number(c));
    } catch {
      // gone
    }
  }
  return out;
}

/**
 * Memory ceiling of a session process tree: the launch value (kept in `launch.json`) and the
 * server's own setting (`environments.session_memory_limit_mb`), the stricter one wins.
 */
export function tighterLimit(launch: number | null | undefined, server: number | null | undefined): number | null {
  if (launch && server) return Math.min(launch, server);
  return launch || server || null;
}

/** Thrown inside the probe transaction of a caller-supplied session id, to roll it back. */
const PROBE_ROLLBACK = new Error('rollback of the session id probe');

/** PostgreSQL unique violation (23505), wrapped or not by Drizzle (« Failed query », cause). */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
