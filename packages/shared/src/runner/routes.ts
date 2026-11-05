import { z } from 'zod';
import { OkResponseSchema } from './common';
import {
  AheadBehindQuerySchema,
  AheadBehindSchema,
  BranchesQuerySchema,
  BranchesResponseSchema,
  BranchResultSchema,
  ChangesQuerySchema,
  ChangesResponseSchema,
  CheckDestinationRequestSchema,
  CheckoutRequestSchema,
  ClaudeMdQuerySchema,
  ClaudeMdSchema,
  CloneRequestSchema,
  CommitRequestSchema,
  CommitResultSchema,
  CreateBranchRequestSchema,
  CreateWorktreeRequestSchema,
  DestinationCheckSchema,
  DiffQuerySchema,
  FetchRequestSchema,
  FetchResultSchema,
  FileContentSchema,
  FileDiffSchema,
  FileQuerySchema,
  GitStatusSchema,
  LogQuerySchema,
  LogResponseSchema,
  OperationStartedResponseSchema,
  PathsRequestSchema,
  ProjectRefSchema,
  PullRequestBodySchema,
  PullResultSchema,
  PushRequestSchema,
  PushResultSchema,
  RemoveWorktreeQuerySchema,
  RemoveWorktreeResultSchema,
  StageResultSchema,
  StatusQuerySchema,
  SyncStatusSchema,
  TreeQuerySchema,
  TreeResponseSchema,
  WorktreeDtoSchema,
  WorktreeRefSchema,
  WorktreesResponseSchema,
  WriteClaudeMdRequestSchema,
  WriteClaudeMdResultSchema,
} from './git';
import { OperationSnapshotSchema } from './operations';
import {
  CreateSessionRequestSchema,
  InstructionRequestSchema,
  InstructionResultSchema,
  PermissionDecisionRequestSchema,
  PermissionParamsSchema,
  PermissionRequestDtoSchema,
  ResumeSessionRequestSchema,
  SessionDtoSchema,
  SessionEventsQuerySchema,
  SessionEventsResponseSchema,
  SessionParamsSchema,
  SessionsListResponseSchema,
  SessionTerminalResponseSchema,
  StartSessionRequestSchema,
  StopSessionRequestSchema,
} from './sessions';
import {
  CreateTerminalRequestSchema,
  TerminalDtoSchema,
  TerminalInputRequestSchema,
  TerminalParamsSchema,
  TerminalResizeRequestSchema,
  TerminalsListResponseSchema,
} from './terminals';
import { CreateRunRequestSchema, RunDtoSchema, RunParamsSchema } from './runs';
import { HealthResponseSchema, SystemMetricsSchema, UptimeQuerySchema, UptimeResponseSchema } from './system';
import {
  ClaudeStatusQuerySchema,
  ClaudeStatusSchema,
  McpCliStatusSchema,
  McpNameParamsSchema,
  McpSyncRequestSchema,
  McpSyncResultSchema,
} from './claude';
import { PublishEventRequestSchema } from '../events';

export type RunnerHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RunnerRouteDef {
  method: RunnerHttpMethod;
  /** Fastify-style path (`/v1/repos/:projectId/fetch`). */
  path: `/v1/${string}`;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Absent for SSE routes (`stream: true`). */
  response?: z.ZodType;
  stream?: true;
  /** Timeout applied by the web client (ms). */
  timeoutMs?: number;
}

const OperationParamsSchema = z.object({ operationId: z.uuid() });
const GIT_NETWORK_TIMEOUT = 150_000;

/**
 * Every runner route (prefix /v1), shared by the server (validation) and the web client (types).
 * All of them require `Authorization: Bearer ${RUNNER_TOKEN}`.
 */
export const RUNNER_ROUTES = {
  // --- Health & system --------------------------------------------------------------------
  health: { method: 'GET', path: '/v1/health', response: HealthResponseSchema, timeoutMs: 20_000 },
  systemMetrics: { method: 'GET', path: '/v1/system/metrics', response: SystemMetricsSchema },
  systemUptime: { method: 'GET', path: '/v1/system/uptime', query: UptimeQuerySchema, response: UptimeResponseSchema },

  // --- Events -----------------------------------------------------------------------------
  events: { method: 'GET', path: '/v1/events', stream: true },
  publishEvent: { method: 'POST', path: '/v1/events/publish', body: PublishEventRequestSchema, response: OkResponseSchema },

  // --- Repositories -----------------------------------------------------------------------
  checkDestination: {
    method: 'POST',
    path: '/v1/repos/check-destination',
    body: CheckDestinationRequestSchema,
    response: DestinationCheckSchema,
  },
  cloneRepo: { method: 'POST', path: '/v1/repos/clone', body: CloneRequestSchema, response: OperationStartedResponseSchema },
  fetchRepo: {
    method: 'POST',
    path: '/v1/repos/:projectId/fetch',
    params: ProjectRefSchema,
    body: FetchRequestSchema,
    response: FetchResultSchema,
    timeoutMs: GIT_NETWORK_TIMEOUT,
  },
  pullRepo: {
    method: 'POST',
    path: '/v1/repos/:projectId/pull',
    params: ProjectRefSchema,
    body: PullRequestBodySchema,
    response: PullResultSchema,
    timeoutMs: GIT_NETWORK_TIMEOUT,
  },
  repoStatus: { method: 'GET', path: '/v1/repos/:projectId/status', params: ProjectRefSchema, query: StatusQuerySchema, response: GitStatusSchema },
  repoSync: { method: 'GET', path: '/v1/repos/:projectId/sync', params: ProjectRefSchema, response: SyncStatusSchema },
  listBranches: {
    method: 'GET',
    path: '/v1/repos/:projectId/branches',
    params: ProjectRefSchema,
    query: BranchesQuerySchema,
    response: BranchesResponseSchema,
    timeoutMs: 30_000,
  },
  createBranch: {
    method: 'POST',
    path: '/v1/repos/:projectId/branches',
    params: ProjectRefSchema,
    body: CreateBranchRequestSchema,
    response: BranchResultSchema,
  },
  checkoutBranch: {
    method: 'POST',
    path: '/v1/repos/:projectId/checkout',
    params: ProjectRefSchema,
    body: CheckoutRequestSchema,
    response: BranchResultSchema,
    timeoutMs: 60_000,
  },
  repoLog: { method: 'GET', path: '/v1/repos/:projectId/log', params: ProjectRefSchema, query: LogQuerySchema, response: LogResponseSchema },

  // --- Worktrees --------------------------------------------------------------------------
  listWorktrees: { method: 'GET', path: '/v1/repos/:projectId/worktrees', params: ProjectRefSchema, response: WorktreesResponseSchema, timeoutMs: 30_000 },
  createWorktree: {
    method: 'POST',
    path: '/v1/repos/:projectId/worktrees',
    params: ProjectRefSchema,
    body: CreateWorktreeRequestSchema,
    response: WorktreeDtoSchema,
    timeoutMs: 120_000,
  },
  removeWorktree: {
    method: 'DELETE',
    path: '/v1/worktrees/:worktreeId',
    params: WorktreeRefSchema,
    query: RemoveWorktreeQuerySchema,
    response: RemoveWorktreeResultSchema,
    timeoutMs: 60_000,
  },
  worktreeStatus: { method: 'GET', path: '/v1/worktrees/:worktreeId/status', params: WorktreeRefSchema, response: GitStatusSchema },

  // --- Changes ----------------------------------------------------------------------------
  worktreeChanges: {
    method: 'GET',
    path: '/v1/worktrees/:worktreeId/changes',
    params: WorktreeRefSchema,
    query: ChangesQuerySchema,
    response: ChangesResponseSchema,
    timeoutMs: 30_000,
  },
  worktreeDiff: {
    method: 'GET',
    path: '/v1/worktrees/:worktreeId/diff',
    params: WorktreeRefSchema,
    query: DiffQuerySchema,
    response: FileDiffSchema,
    timeoutMs: 30_000,
  },
  stagePaths: { method: 'POST', path: '/v1/worktrees/:worktreeId/stage', params: WorktreeRefSchema, body: PathsRequestSchema, response: StageResultSchema },
  unstagePaths: { method: 'POST', path: '/v1/worktrees/:worktreeId/unstage', params: WorktreeRefSchema, body: PathsRequestSchema, response: StageResultSchema },
  commit: {
    method: 'POST',
    path: '/v1/worktrees/:worktreeId/commit',
    params: WorktreeRefSchema,
    body: CommitRequestSchema,
    response: CommitResultSchema,
    timeoutMs: 120_000,
  },
  push: {
    method: 'POST',
    path: '/v1/worktrees/:worktreeId/push',
    params: WorktreeRefSchema,
    body: PushRequestSchema,
    response: PushResultSchema,
    timeoutMs: GIT_NETWORK_TIMEOUT,
  },
  aheadBehind: {
    method: 'GET',
    path: '/v1/worktrees/:worktreeId/ahead-behind',
    params: WorktreeRefSchema,
    query: AheadBehindQuerySchema,
    response: AheadBehindSchema,
  },

  // --- Files ------------------------------------------------------------------------------
  fileTree: { method: 'GET', path: '/v1/worktrees/:worktreeId/tree', params: WorktreeRefSchema, query: TreeQuerySchema, response: TreeResponseSchema },
  readFile: { method: 'GET', path: '/v1/worktrees/:worktreeId/file', params: WorktreeRefSchema, query: FileQuerySchema, response: FileContentSchema },
  readClaudeMd: { method: 'GET', path: '/v1/projects/:projectId/claude-md', params: ProjectRefSchema, query: ClaudeMdQuerySchema, response: ClaudeMdSchema },
  writeClaudeMd: {
    method: 'PUT',
    path: '/v1/projects/:projectId/claude-md',
    params: ProjectRefSchema,
    body: WriteClaudeMdRequestSchema,
    response: WriteClaudeMdResultSchema,
    timeoutMs: 60_000,
  },

  // --- Operations -------------------------------------------------------------------------
  getOperation: { method: 'GET', path: '/v1/operations/:operationId', params: OperationParamsSchema, response: OperationSnapshotSchema },
  operationStream: { method: 'GET', path: '/v1/operations/:operationId/stream', params: OperationParamsSchema, stream: true },

  // --- Terminals --------------------------------------------------------------------------
  createTerminal: { method: 'POST', path: '/v1/terminals', body: CreateTerminalRequestSchema, response: TerminalDtoSchema, timeoutMs: 30_000 },
  listTerminals: { method: 'GET', path: '/v1/terminals', response: TerminalsListResponseSchema },
  getTerminal: { method: 'GET', path: '/v1/terminals/:terminalId', params: TerminalParamsSchema, response: TerminalDtoSchema },
  terminalStream: { method: 'GET', path: '/v1/terminals/:terminalId/stream', params: TerminalParamsSchema, stream: true },
  terminalInput: {
    method: 'POST',
    path: '/v1/terminals/:terminalId/input',
    params: TerminalParamsSchema,
    body: TerminalInputRequestSchema,
    response: OkResponseSchema,
    timeoutMs: 5_000,
  },
  terminalResize: {
    method: 'POST',
    path: '/v1/terminals/:terminalId/resize',
    params: TerminalParamsSchema,
    body: TerminalResizeRequestSchema,
    response: OkResponseSchema,
    timeoutMs: 5_000,
  },
  closeTerminal: { method: 'DELETE', path: '/v1/terminals/:terminalId', params: TerminalParamsSchema, response: OkResponseSchema },

  // --- Claude sessions --------------------------------------------------------------------
  createSession: { method: 'POST', path: '/v1/sessions', body: CreateSessionRequestSchema, response: SessionDtoSchema, timeoutMs: 120_000 },
  listSessions: { method: 'GET', path: '/v1/sessions', response: SessionsListResponseSchema },
  getSession: { method: 'GET', path: '/v1/sessions/:sessionId', params: SessionParamsSchema, response: SessionDtoSchema },
  startSession: {
    method: 'POST',
    path: '/v1/sessions/:sessionId/start',
    params: SessionParamsSchema,
    body: StartSessionRequestSchema,
    response: SessionDtoSchema,
    timeoutMs: 60_000,
  },
  resumeSession: {
    method: 'POST',
    path: '/v1/sessions/:sessionId/resume',
    params: SessionParamsSchema,
    body: ResumeSessionRequestSchema,
    response: SessionDtoSchema,
    timeoutMs: 60_000,
  },
  sendInstruction: {
    method: 'POST',
    path: '/v1/sessions/:sessionId/instruction',
    params: SessionParamsSchema,
    body: InstructionRequestSchema,
    response: InstructionResultSchema,
    timeoutMs: 60_000,
  },
  interruptSession: { method: 'POST', path: '/v1/sessions/:sessionId/interrupt', params: SessionParamsSchema, response: SessionDtoSchema },
  stopSession: {
    method: 'POST',
    path: '/v1/sessions/:sessionId/stop',
    params: SessionParamsSchema,
    body: StopSessionRequestSchema,
    response: SessionDtoSchema,
    timeoutMs: 30_000,
  },
  sessionEvents: {
    method: 'GET',
    path: '/v1/sessions/:sessionId/events',
    params: SessionParamsSchema,
    query: SessionEventsQuerySchema,
    response: SessionEventsResponseSchema,
  },
  sessionStream: { method: 'GET', path: '/v1/sessions/:sessionId/stream', params: SessionParamsSchema, stream: true },
  sessionTerminal: { method: 'GET', path: '/v1/sessions/:sessionId/terminal', params: SessionParamsSchema, response: SessionTerminalResponseSchema },
  permissionDecision: {
    method: 'POST',
    path: '/v1/permissions/:permissionId/decision',
    params: PermissionParamsSchema,
    body: PermissionDecisionRequestSchema,
    response: PermissionRequestDtoSchema,
  },

  // --- Project processes ------------------------------------------------------------------
  createRun: { method: 'POST', path: '/v1/runs', body: CreateRunRequestSchema, response: RunDtoSchema, timeoutMs: 30_000 },
  getRun: { method: 'GET', path: '/v1/runs/:runId', params: RunParamsSchema, response: RunDtoSchema },
  runStream: { method: 'GET', path: '/v1/runs/:runId/stream', params: RunParamsSchema, stream: true },
  stopRun: { method: 'DELETE', path: '/v1/runs/:runId', params: RunParamsSchema, response: RunDtoSchema, timeoutMs: 30_000 },

  // --- Claude CLI -------------------------------------------------------------------------
  claudeStatus: { method: 'GET', path: '/v1/claude/status', query: ClaudeStatusQuerySchema, response: ClaudeStatusSchema, timeoutMs: 45_000 },
  claudeMcpSync: { method: 'POST', path: '/v1/claude/mcp/sync', body: McpSyncRequestSchema, response: McpSyncResultSchema, timeoutMs: 120_000 },
  claudeMcpGet: { method: 'GET', path: '/v1/claude/mcp/:name', params: McpNameParamsSchema, response: McpCliStatusSchema, timeoutMs: 45_000 },
} as const satisfies Record<string, RunnerRouteDef>;

export type RunnerRoutes = typeof RUNNER_ROUTES;
export type RunnerRouteName = keyof RunnerRoutes;
export type JsonRunnerRouteName = {
  [K in RunnerRouteName]: RunnerRoutes[K] extends { stream: true } ? never : K;
}[RunnerRouteName];
export type StreamRunnerRouteName = Exclude<RunnerRouteName, JsonRunnerRouteName>;

type SchemaInput<S> = S extends z.ZodType ? z.input<S> : never;
type SchemaOutput<S> = S extends z.ZodType ? z.output<S> : never;

/** Request pieces of a route (only the ones it declares). */
export type RunnerRouteInput<K extends RunnerRouteName> = (RunnerRoutes[K] extends { params: infer P }
  ? { params: SchemaInput<P> }
  : { params?: undefined }) &
  (RunnerRoutes[K] extends { query: infer Q } ? { query?: SchemaInput<Q> } : { query?: undefined }) &
  (RunnerRoutes[K] extends { body: infer B } ? { body: SchemaInput<B> } : { body?: undefined });

/** Parsed response of a JSON route. */
export type RunnerRouteResponse<K extends RunnerRouteName> = RunnerRoutes[K] extends { response: infer R }
  ? SchemaOutput<R>
  : never;

/** Server-side parsed request pieces. */
export type RunnerRouteParsed<K extends RunnerRouteName> = {
  params: RunnerRoutes[K] extends { params: infer P } ? SchemaOutput<P> : Record<string, never>;
  query: RunnerRoutes[K] extends { query: infer Q } ? SchemaOutput<Q> : Record<string, never>;
  body: RunnerRoutes[K] extends { body: infer B } ? SchemaOutput<B> : undefined;
};

/** Builds `/v1/repos/<id>/fetch` from `/v1/repos/:projectId/fetch`. */
export function buildRunnerPath(path: string, params: Record<string, unknown> | undefined): string {
  return path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Paramètre de route manquant : ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

/** Serialises a query object (undefined/null skipped, booleans as `1`/`0`). */
export function buildRunnerQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    search.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
