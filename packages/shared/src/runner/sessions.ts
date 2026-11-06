import { z } from 'zod';
import {
  BranchNameSchema,
  GitIdentitySchema,
  IsoDateSchema,
  PermissionModeSchema,
  PermissionRequestStatusSchema,
  SessionBackendSchema,
  SessionEventKindSchema,
  SessionStatusSchema,
  UuidSchema,
  WorktreeNameSchema,
} from './common';

// ---------------------------------------------------------------------------------------------
// Status line JSON published by the CLI (stored in sessions.cli_status, never estimated)
// ---------------------------------------------------------------------------------------------

const RateWindowSchema = z.object({
  /** 0–100, as published by the CLI. */
  usedPercentage: z.number().nullable(),
  /** ISO date (converted from the CLI's Unix seconds). */
  resetsAt: IsoDateSchema.nullable(),
});

/** Whitelisted subset of the official status-line JSON (see docs/research/claude-code.md §10). */
export const CliStatusSchema = z.object({
  receivedAt: IsoDateSchema,
  version: z.string().nullable(),
  model: z.object({ id: z.string().nullable(), displayName: z.string().nullable() }).nullable(),
  contextWindow: z
    .object({ usedPercentage: z.number().nullable(), size: z.number().nullable() })
    .nullable(),
  /** Present only for claude.ai Pro/Max/Ultra subscribers, after the first API response. */
  rateLimits: z.object({ fiveHour: RateWindowSchema.nullable(), sevenDay: RateWindowSchema.nullable() }).nullable(),
  effort: z.string().nullable(),
  outputStyle: z.string().nullable(),
  sessionName: z.string().nullable(),
  linesAdded: z.number().nullable(),
  linesRemoved: z.number().nullable(),
  totalDurationMs: z.number().nullable(),
  pr: z.object({ number: z.number().nullable(), url: z.string().nullable() }).nullable(),
});
export type CliStatus = z.infer<typeof CliStatusSchema>;

// ---------------------------------------------------------------------------------------------
// Usage limit of the Claude subscription (sessions.usage_limit, written by the runner)
// ---------------------------------------------------------------------------------------------

/**
 * Where the runner learnt that the session stopped on the subscription usage limit: the
 * `StopFailure` hook (`error: rate_limit`), the limit message the CLI wrote in its transcript or
 * printed on screen (« 5-hour limit reached ∙ resets 3pm »). The reset time itself comes from the
 * status line (`rate_limits.*.resets_at`) when it is known, else from the message.
 */
export const USAGE_LIMIT_SOURCES = ['hook', 'transcript', 'screen', 'status_line'] as const;
export const UsageLimitSourceSchema = z.enum(USAGE_LIMIT_SOURCES);
export type UsageLimitSource = z.infer<typeof UsageLimitSourceSchema>;

/** Optional automatic resumption scheduled by the runner once the limit is lifted. */
export const AutoResumeStateSchema = z.object({
  /** Effective value for this session (space default or session override, computed by the web). */
  enabled: z.boolean(),
  /** Next attempt (reset + margin, or the next retry); null = nothing scheduled. */
  nextAttemptAt: IsoDateSchema.nullable(),
  /** `reset`: at the reset time the CLI gave; `retry`: reset unknown, a try every 30 min (6 h at most). */
  mode: z.enum(['reset', 'retry']).nullable(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  lastAttemptAt: IsoDateSchema.nullable(),
  /** Retry mode only: no attempt after this date. */
  giveUpAt: IsoDateSchema.nullable(),
  /** `exhausted`: attempts used up (or 6 h without a reset time), nothing more is scheduled. */
  outcome: z.enum(['scheduled', 'fired', 'exhausted', 'off']).nullable(),
  /** Why the last attempt could not be made (« 4 sessions actives sur 4 autorisées… »), in French. */
  lastError: z.string().nullable().optional(),
});
export type AutoResumeState = z.infer<typeof AutoResumeStateSchema>;

export const UsageLimitSchema = z.object({
  /** The session is stopped by the limit right now (false once an automatic resumption was typed). */
  active: z.boolean(),
  detectedAt: IsoDateSchema,
  /** When the CLI says the limit is lifted (status line or message); null = not given by the CLI. */
  resetsAt: IsoDateSchema.nullable(),
  source: UsageLimitSourceSchema,
  /** Window named by the CLI (`five_hour`: « session limit », `seven_day`: weekly), null when unknown. */
  window: z.enum(['five_hour', 'seven_day']).nullable(),
  /** The CLI's own message, as printed (redacted, capped). */
  message: z.string().nullable(),
  autoResume: AutoResumeStateSchema.nullable(),
});
export type UsageLimit = z.infer<typeof UsageLimitSchema>;

/** Default instruction typed into the session when it resumes after the limit. */
export const DEFAULT_AUTO_RESUME_INSTRUCTION = "Continue là où tu t'es arrêté.";

/** Launch option and request of `POST /v1/sessions/:id/auto-resume`. */
export const AutoResumeOptionsSchema = z.object({
  enabled: z.boolean(),
  instruction: z.string().trim().min(1).max(2000).optional(),
});
export type AutoResumeOptions = z.infer<typeof AutoResumeOptionsSchema>;

// ---------------------------------------------------------------------------------------------
// Conversation items (session_events.payload by kind)
// ---------------------------------------------------------------------------------------------

export const TestCountsSchema = z.object({
  passed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  running: z.number().int(),
  total: z.number().int(),
  durationMs: z.number().nullable(),
  framework: z.enum(['vitest', 'jest', 'playwright', 'node', 'unknown']),
});
export type TestCounts = z.infer<typeof TestCountsSchema>;

export const ToolMetaSchema = z.discriminatedUnion('kind', [
  /** Read → « 212 lignes ». */
  z.object({ kind: z.literal('lines'), count: z.number().int() }),
  /** Glob / Grep → « 14 fichiers », « 6 résultats ». */
  z.object({ kind: z.literal('matches'), count: z.number().int(), unit: z.enum(['files', 'matches', 'lines']) }),
  /** Edit / Write / MultiEdit → « +46 −12 ». */
  z.object({ kind: z.literal('diff'), added: z.number().int(), removed: z.number().int() }),
  /** Bash → « 10 réussis · 3,2 s », « code 1 · 2 échecs ». */
  z.object({
    kind: z.literal('command'),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().nullable(),
    interrupted: z.boolean(),
    tests: TestCountsSchema.nullable(),
  }),
  z.object({ kind: z.literal('duration'), durationMs: z.number() }),
]);
export type ToolMeta = z.infer<typeof ToolMetaSchema>;

export const PlanItemSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().nullable(),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const PermissionOptionSchema = z.object({
  /** Order = the CLI's order (at most three). */
  id: z.enum(['allow', 'allow_always', 'deny']),
  label: z.string(),
});

export const InstructionPayloadSchema = z.object({
  text: z.string(),
  /** `nuera` = sent from the composer, `terminal` = typed in the raw terminal. */
  source: z.enum(['nuera', 'terminal']),
  at: IsoDateSchema,
});
export const AssistantPayloadSchema = z.object({
  text: z.string(),
  at: IsoDateSchema,
  /** `transcript` = intermediate text block read from the session journal, `stop` = last_assistant_message. */
  source: z.enum(['transcript', 'stop']),
  final: z.boolean(),
});
export const ToolPayloadSchema = z.object({
  toolUseId: z.string().nullable(),
  tool: z.string(),
  /** Command, path, pattern or URL shown after the tool name. */
  target: z.string().nullable(),
  status: z.enum(['running', 'done', 'error', 'denied']),
  meta: ToolMetaSchema.nullable(),
  /** Formatted French meta (« 212 lignes », « +46 −12 », « en cours »). */
  summary: z.string().nullable(),
  /** Bash output (stdout then stderr), redacted and capped. */
  output: z.string().nullable(),
  outputTruncated: z.boolean(),
  error: z.string().nullable(),
  permissionId: UuidSchema.nullable(),
  subagent: z.string().nullable(),
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.nullable(),
});
export const PlanPayloadSchema = z.object({
  items: z.array(PlanItemSchema),
  done: z.number().int(),
  total: z.number().int(),
  /** Current step (activeForm or content of the in-progress item). */
  current: z.string().nullable(),
  at: IsoDateSchema,
});
export const PermissionPayloadSchema = z.object({
  permissionId: UuidSchema,
  tool: z.string(),
  title: z.string(),
  target: z.string().nullable(),
  detail: z.string().nullable(),
  status: PermissionRequestStatusSchema,
  options: z.array(PermissionOptionSchema),
  /** « Commande autorisée une fois · npm run test -- crm » once decided. */
  resolvedLabel: z.string().nullable(),
  at: IsoDateSchema,
  decidedAt: IsoDateSchema.nullable(),
});
export const NotificationPayloadSchema = z.object({
  notificationType: z.string().nullable(),
  title: z.string().nullable(),
  message: z.string(),
  at: IsoDateSchema,
});
export const StatusPayloadSchema = z.object({
  status: SessionStatusSchema,
  /** French label (« Session démarrée », « Session reprise », « Session arrêtée »). */
  label: z.string(),
  at: IsoDateSchema,
});
export const ErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
  detail: z.string().nullable(),
  at: IsoDateSchema,
});
export const CompactPayloadSchema = z.object({
  trigger: z.string().nullable(),
  phase: z.enum(['start', 'done']),
  summary: z.string().nullable(),
  at: IsoDateSchema,
});
export const SubagentPayloadSchema = z.object({
  agentId: z.string().nullable(),
  agentType: z.string().nullable(),
  status: z.enum(['running', 'done']),
  lastMessage: z.string().nullable(),
  at: IsoDateSchema,
});
export const SystemPayloadSchema = z.object({ message: z.string(), at: IsoDateSchema });

const itemBase = {
  id: z.number().int(),
  sessionId: UuidSchema,
  position: z.number().int(),
  version: z.number().int(),
  key: z.string().nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
};

/** One normalised conversation item (row of session_events). */
export const SessionEventItemSchema = z.discriminatedUnion('kind', [
  z.object({ ...itemBase, kind: z.literal('instruction'), payload: InstructionPayloadSchema }),
  z.object({ ...itemBase, kind: z.literal('assistant'), payload: AssistantPayloadSchema }),
  z.object({ ...itemBase, kind: z.literal('tool'), payload: ToolPayloadSchema }),
  z.object({ ...itemBase, kind: z.literal('plan'), payload: PlanPayloadSchema }),
  z.object({ ...itemBase, kind: z.literal('permission'), payload: PermissionPayloadSchema }),
  z.object({ ...itemBase, kind: z.literal('notification'), payload: NotificationPayloadSchema }),
  z.object({ ...itemBase, kind: z.literal('status'), payload: StatusPayloadSchema }),
  z.object({ ...itemBase, kind: z.literal('error'), payload: ErrorPayloadSchema }),
  z.object({ ...itemBase, kind: z.literal('compact'), payload: CompactPayloadSchema }),
  z.object({ ...itemBase, kind: z.literal('subagent'), payload: SubagentPayloadSchema }),
  z.object({ ...itemBase, kind: z.literal('system'), payload: SystemPayloadSchema }),
]);
export type SessionEventItem = z.infer<typeof SessionEventItemSchema>;
export type SessionEventKindValue = z.infer<typeof SessionEventKindSchema>;
export type SessionEventPayloadOf<K extends SessionEventKindValue> = Extract<SessionEventItem, { kind: K }>['payload'];

// ---------------------------------------------------------------------------------------------
// Permission requests
// ---------------------------------------------------------------------------------------------

export const PermissionRequestDtoSchema = z.object({
  id: UuidSchema,
  sessionId: UuidSchema,
  toolName: z.string(),
  title: z.string(),
  target: z.string().nullable(),
  detail: z.string().nullable(),
  status: PermissionRequestStatusSchema,
  options: z.array(PermissionOptionSchema),
  /** « Toujours pour npm run test » when the CLI offered a rule suggestion. */
  alwaysLabel: z.string().nullable(),
  /** Raw `permission_suggestions` from the CLI (used verbatim for « Toujours »). */
  suggestions: z.array(z.unknown()).nullable(),
  decisionMessage: z.string().nullable(),
  createdAt: IsoDateSchema,
  decidedAt: IsoDateSchema.nullable(),
  expiresAt: IsoDateSchema.nullable(),
});
export type PermissionRequestDto = z.infer<typeof PermissionRequestDtoSchema>;

export const PermissionDecisionRequestSchema = z.object({
  behavior: z.enum(['allow', 'deny']),
  /** Allow and remember the CLI's own rule suggestion (« Toujours pour … »). */
  always: z.boolean().default(false),
  /** Message given to Claude on deny. */
  message: z.string().trim().max(2000).optional(),
  decidedByUserId: z.string().nullish(),
});
export const PermissionParamsSchema = z.object({ permissionId: UuidSchema });

// ---------------------------------------------------------------------------------------------
// MCP configuration passed at session start (from the web's buildSessionMcpConfig)
// ---------------------------------------------------------------------------------------------

const McpHeadersSchema = z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(4096));
/** `headersHelper: 'nuera'` → the runner substitutes its own helper (bin/nuera-mcp-headers.mjs). Any other command is refused. */
const McpRemoteServerSchema = z.object({
  type: z.enum(['http', 'sse', 'ws', 'streamable-http']),
  url: z.url().max(2048),
  headers: McpHeadersSchema.optional(),
  headersHelper: z.literal('nuera').optional(),
  timeout: z.number().int().min(1000).max(600_000).optional(),
});
const McpStdioServerSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1).max(1024),
  args: z.array(z.string().max(4096)).max(100).default([]),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192)).optional(),
});
export const McpServerConfigSchema = z.union([McpRemoteServerSchema, McpStdioServerSchema]);
export const McpConfigSchema = z.object({
  mcpServers: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), McpServerConfigSchema),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

/** Environment additions for the session (non-secret). Protected names are refused by the runner. */
export const SessionEnvSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(8192));

/**
 * Launch options, given at creation and again (optionally) on resume; the runner keeps them with the
 * session (launch.json). Every field added later is OPTIONAL: a launch file written by an older
 * version must still be read. The session policies come from here (computed by the web from the
 * space and instance settings), never from the deprecated columns of `app_settings`.
 */
export const SessionLaunchOptionsSchema = z.object({
  mcpConfig: McpConfigSchema.nullish(),
  /** `permissions.deny` rules (e.g. `mcp__coolify__deploy`). */
  denyRules: z.array(z.string().min(1).max(500)).max(500).default([]),
  env: SessionEnvSchema.default({}),
  /** How long the PermissionRequest hook waits for a decision taken in Nuera Dev (space setting; default 120 s). */
  permissionWaitSeconds: z.number().int().min(5).max(3600).optional(),
  /**
   * « Bloquer le mode sans autorisation », effective value (instance OR space). Absent (older web):
   * the runner falls back to its space (`space_settings`, `app_settings.force_block_bypass_permissions`),
   * blocked when unknown.
   */
  blockBypassPermissions: z.boolean().optional(),
  /** Concurrency cap (default: the server's `environments.max_concurrent_sessions`). */
  maxConcurrentSessions: z.number().int().min(1).max(64).optional(),
  /** Memory ceiling for the session process tree (MiB, default: `environments.session_memory_limit_mb`). */
  memoryLimitMb: z.number().int().min(128).max(262_144).nullish(),
  /**
   * Author and committer of the commits Claude makes in this session (the account that starts or
   * resumes it): injected by the runner as GIT_AUTHOR_* / GIT_COMMITTER_* (the GIT_ prefix stays
   * refused in `env`). Absent: the Git configuration of the server.
   */
  gitIdentity: GitIdentitySchema.nullish(),
  /**
   * « Reprise automatique après la limite d'utilisation » (space default or session override) and
   * the instruction typed then. Absent (older web, older launch file): off.
   */
  autoResume: AutoResumeOptionsSchema.optional(),
});
export type SessionLaunchOptions = z.input<typeof SessionLaunchOptionsSchema>;

// ---------------------------------------------------------------------------------------------
// Session routes
// ---------------------------------------------------------------------------------------------

export const SessionWorktreeSpecSchema = z.discriminatedUnion('mode', [
  /** New worktree + branch (W6 « Nouvelle session dans un nouveau worktree »). */
  z.object({
    mode: z.literal('new'),
    branch: BranchNameSchema,
    name: WorktreeNameSchema.optional(),
    base: BranchNameSchema.optional(),
  }),
  z.object({ mode: z.literal('existing'), worktreeId: UuidSchema }),
  /** The primary clone itself. */
  z.object({ mode: z.literal('primary') }),
]);

export const ModelNameSchema = z.string().trim().regex(/^[A-Za-z0-9._:[\]-]{1,80}$/, { message: 'Modèle invalide.' });
export const EffortSchema = z.string().trim().regex(/^[a-z]{2,16}$/, { message: "Niveau d'effort invalide." });

export const CreateSessionRequestSchema = z.object({
  /** Optional pre-generated id (also the Claude conversation id). */
  sessionId: UuidSchema.optional(),
  projectId: UuidSchema,
  title: z.string().trim().min(1).max(200).default('Nouvelle session'),
  worktree: SessionWorktreeSpecSchema,
  permissionMode: PermissionModeSchema.default('manual'),
  model: ModelNameSchema.nullish(),
  effort: EffortSchema.nullish(),
  /** `--remote-control "<titre>"`. */
  remoteControl: z.boolean().default(false),
  launch: SessionLaunchOptionsSchema.default({ denyRules: [], env: {} }),
  /** Start the CLI now (otherwise at the first instruction, Figma W1). */
  start: z.boolean().default(false),
  createdByUserId: z.string().nullish(),
});
export type CreateSessionRequest = z.input<typeof CreateSessionRequestSchema>;

export const SessionDtoSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  worktreeId: UuidSchema.nullable(),
  title: z.string(),
  status: SessionStatusSchema,
  backend: SessionBackendSchema,
  tmuxName: z.string().nullable(),
  permissionMode: PermissionModeSchema,
  model: z.string().nullable(),
  effort: z.string().nullable(),
  remoteControl: z.boolean(),
  remoteControlUrl: z.string().nullable(),
  /** A CLI process is attached right now. */
  live: z.boolean(),
  /** Worktree present and conversation recorded (« reprise possible »). */
  resumable: z.boolean(),
  pid: z.number().int().nullable(),
  terminalId: z.string().nullable(),
  lastInstruction: z.string().nullable(),
  currentActivity: z.string().nullable(),
  planDone: z.number().int().nullable(),
  planTotal: z.number().int().nullable(),
  cliStatus: CliStatusSchema.nullable(),
  pendingPermission: PermissionRequestDtoSchema.nullable(),
  /** Instructions accepted but not yet typed into the CLI (waiting for it to be ready). */
  queuedInstructions: z.number().int(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** Stopped on the subscription usage limit (and its automatic resumption). Absent from older runners. */
  limit: UsageLimitSchema.nullable().optional(),
  exitCode: z.number().int().nullable(),
  resumeCount: z.number().int(),
  startedAt: IsoDateSchema.nullable(),
  endedAt: IsoDateSchema.nullable(),
  lastActivityAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
  worktree: z
    .object({ id: UuidSchema, name: z.string(), branch: z.string(), baseBranch: z.string().nullable(), path: z.string(), isPrimary: z.boolean() })
    .nullable(),
});
export type SessionDto = z.infer<typeof SessionDtoSchema>;

export const SessionParamsSchema = z.object({ sessionId: UuidSchema });
export const SessionsListResponseSchema = z.object({
  sessions: z.array(SessionDtoSchema),
  capacity: z.object({ live: z.number().int(), max: z.number().int() }),
});

export const StartSessionRequestSchema = z.object({ launch: SessionLaunchOptionsSchema.partial().optional() });
export const ResumeSessionRequestSchema = StartSessionRequestSchema;

export const InstructionRequestSchema = z.object({
  text: z.string().min(1).max(100_000),
});
export const InstructionResultSchema = z.object({
  /** Typed into the CLI right now. */
  delivered: z.boolean(),
  /** Accepted, will be typed as soon as the CLI is ready (just started / resumed). */
  queued: z.boolean(),
  started: z.boolean(),
  resumed: z.boolean(),
  session: SessionDtoSchema,
});

export const AutoResumeRequestSchema = AutoResumeOptionsSchema;

export const StopSessionRequestSchema = z.object({
  /** Kill without trying `/exit` first. */
  force: z.boolean().default(false),
});

export const SessionEventsQuerySchema = z.object({
  afterVersion: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});
export const SessionEventsResponseSchema = z.object({
  sessionId: UuidSchema,
  items: z.array(SessionEventItemSchema),
  /** Highest version included (pass it back as `afterVersion`). */
  version: z.number().int(),
  hasMore: z.boolean(),
});

export const SessionTerminalResponseSchema = z.object({ terminalId: z.string().nullable(), live: z.boolean() });
