import 'server-only';
import {
  commandRuns,
  environmentSpaces,
  environments,
  operations,
  permissionRequests,
  projects,
  sessions,
  worktrees,
} from '@nuera/db/schema';
import type { TerminalDto } from '@nuera/shared/runner';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getRunnerEndpoint, getRunnerForEnvironment, RunnerError, type RunnerClient, type RunnerEndpoint } from '@/server/runner/client';
import { audit, type AuditEntry } from '@/server/security/audit';
import type { RequestContext } from './context';

/**
 * Resource → space check → server (docs/MULTICOMPTE.md §5). Every helper is ONE indexed query that
 * puts the space in the WHERE clause itself, so an id of another space is indistinguishable from an
 * unknown id: same AppError NOT_FOUND, same French message as before the multi-account model, no
 * runner call, nothing written. The returned `runner` talks to the server HOLDING the resource
 * (`projects.environment_id`), never to « the current server of the space ».
 *
 *   const scope = await scopeOfProject(ctx, params.projectId);
 *   const status = await scope.runner.repoStatus({ params: { projectId: scope.projectId } });
 *
 * State checks (archived project, removed worktree…) stay with the callers, AFTER the scope check:
 * the scope carries what they need (`projectArchivedAt`, `worktreeRemovedAt`).
 */

export interface ResourceScope {
  spaceId: string;
  /** Server holding the resource (immutable for a project and everything below it). */
  environmentId: string;
  environmentName: string;
  projectId?: string | null;
  /** Runner client of `environmentId`. */
  runner: RunnerClient;
  /** Endpoint of `environmentId` (stream relays). */
  endpoint: () => Promise<RunnerEndpoint>;
}

export interface ProjectScope extends ResourceScope {
  projectId: string;
  projectArchivedAt: Date | null;
}
export interface SessionScope extends ProjectScope {
  sessionId: string;
  worktreeId: string | null;
}
export interface WorktreeScope extends ProjectScope {
  worktreeId: string;
  worktreeRemovedAt: Date | null;
}
export interface RunScope extends ProjectScope {
  runId: string;
}
export interface OperationScope extends ResourceScope {
  operationId: string;
  /** null for an operation without project (integration or MCP check, maintenance). */
  projectId: string | null;
}
export interface PermissionScope extends ProjectScope {
  permissionId: string;
  sessionId: string;
}
export interface TerminalScope extends ResourceScope {
  terminalId: string;
  /** The runner's view of the terminal (already fetched: reuse it instead of calling again). */
  terminal: TerminalDto;
}

/** Overrides of the NOT_FOUND copy, for callers whose message differs (« Projet introuvable. »…). */
export interface ScopeOptions {
  notFound?: string;
  untouched?: string;
}

/** Today's NOT_FOUND copy of each resource (kept byte for byte). */
export const NOT_FOUND_MESSAGES = {
  project: 'Projet introuvable : il a peut-être été retiré.',
  session: 'Session introuvable.',
  worktree: 'Worktree introuvable.',
  run: 'Lancement introuvable.',
  operation: 'Opération introuvable.',
  permission: "Demande d'autorisation introuvable.",
  terminal: 'Terminal introuvable ou fermé.',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Terminal ids of the runner (same pattern as `TerminalParamsSchema`). */
export const TERMINAL_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function notFound(kind: keyof typeof NOT_FOUND_MESSAGES, options: ScopeOptions | undefined): AppError {
  return new AppError('NOT_FOUND', options?.notFound ?? NOT_FOUND_MESSAGES[kind], options?.untouched ? { untouched: options.untouched } : {});
}

function serverOf(spaceId: string, environmentId: string, environmentName: string): ResourceScope {
  return {
    spaceId,
    environmentId,
    environmentName,
    runner: getRunnerForEnvironment(environmentId),
    endpoint: () => getRunnerEndpoint(environmentId),
  };
}

/** `projects.space_id = <space of ctx>` AND the other conditions (lists of projects). */
export function ofSpace(ctx: Pick<RequestContext, 'space'>, ...conditions: Array<SQL | undefined>): SQL {
  return inSpace(projects.spaceId, ctx, ...conditions);
}

/** `<column> = <space of ctx>` AND the other conditions (tables with their own `space_id`). */
export function inSpace(column: AnyPgColumn, ctx: Pick<RequestContext, 'space'>, ...conditions: Array<SQL | undefined>): SQL {
  return and(eq(column, ctx.space.id), ...conditions)!;
}

const projectServer = {
  spaceId: projects.spaceId,
  projectId: projects.id,
  projectArchivedAt: projects.archivedAt,
  environmentId: environments.id,
  environmentName: environments.name,
};

export async function scopeOfProject(ctx: Pick<RequestContext, 'space'>, projectId: string, options?: ScopeOptions): Promise<ProjectScope> {
  if (!UUID.test(projectId)) throw notFound('project', options);
  const [row] = await db
    .select(projectServer)
    .from(projects)
    .innerJoin(environments, eq(environments.id, projects.environmentId))
    .where(and(eq(projects.id, projectId), eq(projects.spaceId, ctx.space.id)))
    .limit(1);
  if (!row) throw notFound('project', options);
  return { ...serverOf(row.spaceId, row.environmentId, row.environmentName), projectId: row.projectId, projectArchivedAt: row.projectArchivedAt };
}

export async function scopeOfSession(ctx: Pick<RequestContext, 'space'>, sessionId: string, options?: ScopeOptions): Promise<SessionScope> {
  if (!UUID.test(sessionId)) throw notFound('session', options);
  const [row] = await db
    .select({ ...projectServer, sessionId: sessions.id, worktreeId: sessions.worktreeId })
    .from(sessions)
    .innerJoin(projects, and(eq(projects.id, sessions.projectId), eq(projects.environmentId, sessions.environmentId)))
    .innerJoin(environments, eq(environments.id, sessions.environmentId))
    .where(and(eq(sessions.id, sessionId), eq(projects.spaceId, ctx.space.id)))
    .limit(1);
  if (!row) throw notFound('session', options);
  return {
    ...serverOf(row.spaceId, row.environmentId, row.environmentName),
    projectId: row.projectId,
    projectArchivedAt: row.projectArchivedAt,
    sessionId: row.sessionId,
    worktreeId: row.worktreeId,
  };
}

export async function scopeOfWorktree(ctx: Pick<RequestContext, 'space'>, worktreeId: string, options?: ScopeOptions): Promise<WorktreeScope> {
  if (!UUID.test(worktreeId)) throw notFound('worktree', options);
  const [row] = await db
    .select({ ...projectServer, worktreeId: worktrees.id, worktreeRemovedAt: worktrees.removedAt })
    .from(worktrees)
    .innerJoin(projects, and(eq(projects.id, worktrees.projectId), eq(projects.environmentId, worktrees.environmentId)))
    .innerJoin(environments, eq(environments.id, worktrees.environmentId))
    .where(and(eq(worktrees.id, worktreeId), eq(projects.spaceId, ctx.space.id)))
    .limit(1);
  if (!row) throw notFound('worktree', options);
  return {
    ...serverOf(row.spaceId, row.environmentId, row.environmentName),
    projectId: row.projectId,
    projectArchivedAt: row.projectArchivedAt,
    worktreeId: row.worktreeId,
    worktreeRemovedAt: row.worktreeRemovedAt,
  };
}

export async function scopeOfRun(ctx: Pick<RequestContext, 'space'>, runId: string, options?: ScopeOptions): Promise<RunScope> {
  if (!UUID.test(runId)) throw notFound('run', options);
  const [row] = await db
    .select({ ...projectServer, runId: commandRuns.id })
    .from(commandRuns)
    .innerJoin(projects, and(eq(projects.id, commandRuns.projectId), eq(projects.environmentId, commandRuns.environmentId)))
    .innerJoin(environments, eq(environments.id, commandRuns.environmentId))
    .where(and(eq(commandRuns.id, runId), eq(projects.spaceId, ctx.space.id)))
    .limit(1);
  if (!row) throw notFound('run', options);
  return {
    ...serverOf(row.spaceId, row.environmentId, row.environmentName),
    projectId: row.projectId,
    projectArchivedAt: row.projectArchivedAt,
    runId: row.runId,
  };
}

/**
 * An operation with a project is scoped through that project (it must be in the space). One without
 * project (integration or MCP check, maintenance) belongs to its server: on a shared server (lot P1)
 * only its first account (`environments.space_id`) sees it, never the other accounts.
 */
export async function scopeOfOperation(ctx: Pick<RequestContext, 'space'>, operationId: string, options?: ScopeOptions): Promise<OperationScope> {
  if (!UUID.test(operationId)) throw notFound('operation', options);
  const [row] = await db
    .select({
      operationId: operations.id,
      projectId: operations.projectId,
      projectSpaceId: projects.spaceId,
      primarySpaceId: environments.spaceId,
      environmentId: environments.id,
      environmentName: environments.name,
    })
    .from(operations)
    .innerJoin(environments, eq(environments.id, operations.environmentId))
    .leftJoin(projects, and(eq(projects.id, operations.projectId), eq(projects.environmentId, operations.environmentId)))
    .where(eq(operations.id, operationId))
    .limit(1);
  const allowed = row && (row.projectId !== null ? row.projectSpaceId === ctx.space.id : row.primarySpaceId === ctx.space.id);
  if (!row || !allowed) throw notFound('operation', options);
  return { ...serverOf(ctx.space.id, row.environmentId, row.environmentName), operationId: row.operationId, projectId: row.projectId };
}

/** Accounts a server works for (lot P1: 1 unless shared). */
export async function serverAccountCount(environmentId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(environmentSpaces)
    .where(eq(environmentSpaces.environmentId, environmentId));
  return Number(row?.count ?? 0);
}

export async function scopeOfPermission(ctx: Pick<RequestContext, 'space'>, permissionId: string, options?: ScopeOptions): Promise<PermissionScope> {
  if (!UUID.test(permissionId)) throw notFound('permission', options);
  const [row] = await db
    .select({ ...projectServer, permissionId: permissionRequests.id, sessionId: sessions.id })
    .from(permissionRequests)
    .innerJoin(sessions, eq(sessions.id, permissionRequests.sessionId))
    .innerJoin(projects, and(eq(projects.id, sessions.projectId), eq(projects.environmentId, sessions.environmentId)))
    .innerJoin(environments, eq(environments.id, sessions.environmentId))
    .where(and(eq(permissionRequests.id, permissionId), eq(projects.spaceId, ctx.space.id)))
    .limit(1);
  if (!row) throw notFound('permission', options);
  return {
    ...serverOf(row.spaceId, row.environmentId, row.environmentName),
    projectId: row.projectId,
    projectArchivedAt: row.projectArchivedAt,
    permissionId: row.permissionId,
    sessionId: row.sessionId,
  };
}

// ---------------------------------------------------------------------------------------------
// Terminals live on the runner only: the server of ctx is asked, then ownership is verified.
// ---------------------------------------------------------------------------------------------

const TERMINAL_VERDICT_TTL_MS = 60_000;
const verdictHolder = globalThis as unknown as { __nueraTerminalVerdicts?: Map<string, number> };

function verdicts(): Map<string, number> {
  verdictHolder.__nueraTerminalVerdicts ??= new Map();
  return verdictHolder.__nueraTerminalVerdicts;
}

/** Forgets the cached terminal verdicts (a terminal closed, tests). */
export function invalidateTerminalScope(terminalId?: string): void {
  if (!terminalId) {
    verdicts().clear();
    return;
  }
  for (const key of verdicts().keys()) if (key.endsWith(`|${terminalId}`)) verdicts().delete(key);
}

/**
 * Terminal of the server of ctx. Refused (NOT_FOUND « Terminal introuvable ou fermé. », same copy
 * as the runner's) when ctx has no server, when the runner does not know it, when it was opened by
 * another account (`ownerUserId`, when the runner reports it), when it works for another space
 * (`spaceId`, contract 3), or when its worktree/session is not in the space. A terminal that names
 * neither owner, space, worktree nor session (older runner) is accepted only on a server that works
 * for this account alone (lot P1: never on a shared server).
 */
export async function scopeOfTerminal(
  ctx: Pick<RequestContext, 'space' | 'environment' | 'user'>,
  terminalId: string,
  options?: ScopeOptions,
): Promise<TerminalScope> {
  const environment = ctx.environment;
  if (!environment || !TERMINAL_ID_PATTERN.test(terminalId)) throw notFound('terminal', options);
  const scope = serverOf(ctx.space.id, environment.id, environment.name);
  let terminal: TerminalDto;
  try {
    terminal = await scope.runner.getTerminal({ params: { terminalId } });
  } catch (error) {
    if (error instanceof RunnerError && error.code === 'NOT_FOUND') throw notFound('terminal', options);
    throw error;
  }
  if (terminal.ownerUserId && terminal.ownerUserId !== ctx.user.id) throw notFound('terminal', options);
  if (terminal.spaceId && terminal.spaceId.toLowerCase() !== ctx.space.id.toLowerCase()) throw notFound('terminal', options);
  if (!terminal.ownerUserId && !terminal.spaceId && !terminal.worktreeId && !terminal.sessionId && (await serverAccountCount(environment.id)) > 1) {
    throw notFound('terminal', options);
  }
  if (terminal.worktreeId) {
    await scopeOfWorktree(ctx, terminal.worktreeId).catch(() => {
      throw notFound('terminal', options);
    });
  }
  if (terminal.sessionId) {
    await scopeOfSession(ctx, terminal.sessionId).catch(() => {
      throw notFound('terminal', options);
    });
  }
  verdicts().set(`${ctx.user.id}|${environment.id}|${terminalId}`, Date.now() + TERMINAL_VERDICT_TTL_MS);
  return { ...scope, terminalId, terminal };
}

/**
 * Cheap check for the keystroke routes (`/input`, `/resize`: a request every ~10 ms): a positive
 * verdict of {@link scopeOfTerminal} is reused for 60 s, otherwise the full check runs. Returns
 * the server's runner client.
 */
export async function scopeOfTerminalInput(
  ctx: Pick<RequestContext, 'space' | 'environment' | 'user'>,
  terminalId: string,
  options?: ScopeOptions,
): Promise<ResourceScope & { terminalId: string }> {
  const environment = ctx.environment;
  if (!environment || !TERMINAL_ID_PATTERN.test(terminalId)) throw notFound('terminal', options);
  const key = `${ctx.user.id}|${environment.id}|${terminalId}`;
  const until = verdicts().get(key);
  if (until && until > Date.now()) return { ...serverOf(ctx.space.id, environment.id, environment.name), terminalId };
  const scope = await scopeOfTerminal(ctx, terminalId, options);
  return { ...scope, terminalId };
}

// ---------------------------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------------------------

/** Entry of {@link auditIn}: actor, space and (default) server come from ctx. */
export type ScopedAuditEntry = Omit<AuditEntry, 'actorUserId' | 'actorKind' | 'spaceId' | 'actorLabel'> & {
  /** Server of the resource acted on; default: the server of ctx (null when none). */
  environmentId?: string | null;
};

/** `audit()` with the acting account, its space and the server (resource's, else the space's). */
export function auditIn(ctx: Pick<RequestContext, 'user' | 'space' | 'environment'>, entry: ScopedAuditEntry): Promise<void> {
  return audit({
    ...entry,
    actorUserId: ctx.user.id,
    actorKind: 'user',
    actorLabel: ctx.user.email,
    spaceId: ctx.space.id,
    environmentId: entry.environmentId !== undefined ? entry.environmentId : (ctx.environment?.id ?? null),
  });
}
