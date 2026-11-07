import 'server-only';
import { permissionRequests, projects, sessionEvents, sessions, worktrees } from '@nuera/db/schema';
import { parseUsageLimit, type SessionDto } from '@nuera/shared/runner';
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  ACTIVE_STATUSES,
  HISTORY_PAGE_SIZE,
  HISTORY_PERIOD_DAYS,
  HISTORY_STATUSES,
  LIVE_STATUSES,
  type HistoryFilter,
  type HistoryPeriod,
  type ResumeBlockedReason,
  type SessionCapacity,
  type SessionListItem,
  type SessionListPage,
  type SessionStatus,
  type SessionSummary,
} from '@/features/sessions/lib/contract';
import { capacityTitle } from '@/features/sessions/lib/view';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getRunnerForEnvironment, isRunnerUnavailable, type RunnerClient } from '@/server/runner/client';
import { getEnvironmentSettings } from '@/server/settings';
import type { RequestContext } from '@/server/tenancy/context';
import { NOT_FOUND_MESSAGES, ofSpace, scopeOfSession } from '@/server/tenancy/scope';

/**
 * Read side of the sessions lot: lists (D06 « EN COURS », « HISTORIQUE »), capacity, summary.
 * The database is the source; the runner (when it answers) confirms what only it knows: which
 * CLI is alive and whether a stopped conversation can really be resumed (journal on disk).
 *
 * Every query is limited to the space of ctx (`ofSpace`), and every runner call goes to the server
 * HOLDING the session (`sessions.environment_id`): a list never mixes spaces, and a runner is
 * never asked about a session of another server.
 */

const RESUMABLE_STATUSES = ['interrupted', 'stopped', 'failed'] as const satisfies readonly SessionStatus[];
/**
 * Ended statuses « Reprendre » accepts — the runner's rule (`resumable`: not live, neither the session
 * nor its project archived; a removed worktree is recreated, a lost conversation restarts with a new
 * context). A finished session can be resumed too (D06 menu « Reprendre »); it keeps its « Terminée »
 * badge, and the « reprise » filters stay about interrupted conversations.
 */
const RESUME_STATUSES = [...RESUMABLE_STATUSES, 'finished'] as const satisfies readonly SessionStatus[];

const columns = {
  id: sessions.id,
  title: sessions.title,
  status: sessions.status,
  permissionMode: sessions.permissionMode,
  model: sessions.model,
  effort: sessions.effort,
  remoteControl: sessions.remoteControl,
  currentActivity: sessions.currentActivity,
  lastInstruction: sessions.lastInstruction,
  errorMessage: sessions.errorMessage,
  usageLimit: sessions.usageLimit,
  autoResume: sessions.autoResume,
  planDone: sessions.planDone,
  planTotal: sessions.planTotal,
  transcriptPath: sessions.transcriptPath,
  createdAt: sessions.createdAt,
  startedAt: sessions.startedAt,
  endedAt: sessions.endedAt,
  lastActivityAt: sessions.lastActivityAt,
  archivedAt: sessions.archivedAt,
  projectId: projects.id,
  projectName: projects.name,
  projectSlug: projects.slug,
  projectFullName: projects.githubFullName,
  projectArchivedAt: projects.archivedAt,
  projectStatus: projects.status,
  worktreeId: worktrees.id,
  worktreeName: worktrees.name,
  worktreeBranch: worktrees.branch,
  worktreeIsPrimary: worktrees.isPrimary,
  worktreeStatus: worktrees.status,
  worktreeRemovedAt: worktrees.removedAt,
  environmentId: sessions.environmentId,
  /** Exact sort key (microseconds) for the pagination cursor. */
  startKeyText: sql<string>`to_char(coalesce(${sessions.startedAt}, ${sessions.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
};

export type SessionRow = {
  id: string;
  title: string;
  status: SessionStatus;
  permissionMode: SessionListItem['permissionMode'];
  model: string | null;
  effort: string | null;
  remoteControl: boolean;
  currentActivity: string | null;
  lastInstruction: string | null;
  errorMessage: string | null;
  usageLimit: Record<string, unknown> | null;
  autoResume: boolean | null;
  planDone: number | null;
  planTotal: number | null;
  transcriptPath: string | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  lastActivityAt: Date | null;
  archivedAt: Date | null;
  projectId: string;
  projectName: string;
  projectSlug: string;
  projectFullName: string;
  projectArchivedAt: Date | null;
  /** `ready`, `cloning`, `error`, `archived` (absent from rows read by older queries: ready). */
  projectStatus?: string;
  worktreeId: string | null;
  worktreeName: string | null;
  worktreeBranch: string | null;
  worktreeIsPrimary: boolean | null;
  worktreeStatus: string | null;
  worktreeRemovedAt: Date | null;
  /** Server holding the session (its runner is the one asked about it). */
  environmentId: string;
  startKeyText?: string;
};

const startKey = sql<Date>`coalesce(${sessions.startedAt}, ${sessions.createdAt})`;
const timestamp = (date: Date) => sql`${date.toISOString()}::timestamptz`;

/** sessions ⋈ projects ⋈ worktrees: every caller filters with `ofSpace(ctx, …)`. */
function baseQuery() {
  return db
    .select(columns)
    .from(sessions)
    .innerJoin(projects, and(eq(projects.id, sessions.projectId), eq(projects.environmentId, sessions.environmentId)))
    .leftJoin(worktrees, eq(worktrees.id, sessions.worktreeId));
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

function worktreePresent(row: SessionRow): boolean {
  return Boolean(row.worktreeId && row.worktreeStatus === 'active' && !row.worktreeRemovedAt);
}

function projectUsable(row: Pick<SessionRow, 'projectArchivedAt' | 'projectStatus'>): boolean {
  return !row.projectArchivedAt && (row.projectStatus ?? 'ready') !== 'archived';
}

/**
 * « Reprise possible » as far as the database can tell — the same rule as the runner: an ended
 * session of a project that is not archived (the runner also tells HOW: `resumeMode`).
 */
export function resumableFromDatabase(row: Pick<SessionRow, 'status' | 'projectArchivedAt' | 'projectStatus'>): boolean {
  return (RESUME_STATUSES as readonly SessionStatus[]).includes(row.status) && projectUsable(row);
}

export function resumeBlockedReason(row: Pick<SessionRow, 'status' | 'projectArchivedAt' | 'projectStatus'>, resumable: boolean): ResumeBlockedReason | null {
  if (resumable) return null;
  if (row.status === 'archived') return 'archived';
  if (!(RESUMABLE_STATUSES as readonly SessionStatus[]).includes(row.status)) return null;
  return projectUsable(row) ? null : 'project_archived';
}

export function toListItem(
  row: SessionRow,
  overlay: { live?: boolean; resumable?: boolean; dto?: SessionDto | null } = {},
): SessionListItem {
  const dto = overlay.dto ?? null;
  const status = dto?.status ?? row.status;
  const live = overlay.live ?? dto?.live ?? (LIVE_STATUSES as readonly SessionStatus[]).includes(status);
  const resumable = overlay.resumable ?? dto?.resumable ?? resumableFromDatabase(row);
  const startedAt = dto?.startedAt ?? iso(row.startedAt);
  const endedAt = dto?.endedAt ?? iso(row.endedAt);
  const durationMs =
    startedAt && endedAt && !live ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null;
  return {
    id: row.id,
    title: row.title,
    status,
    live,
    resumable,
    resumeMode: resumable ? (dto?.resumeMode ?? null) : null,
    resumeBlockedReason: resumeBlockedReason({ ...row, status }, resumable),
    project: {
      id: row.projectId,
      name: row.projectName,
      slug: row.projectSlug,
      fullName: row.projectFullName,
      archived: Boolean(row.projectArchivedAt),
    },
    branch: dto?.worktree?.branch ?? row.worktreeBranch,
    worktree: row.worktreeId
      ? {
          id: row.worktreeId,
          name: row.worktreeName ?? '',
          isPrimary: Boolean(row.worktreeIsPrimary),
          present: worktreePresent(row),
        }
      : null,
    permissionMode: dto?.permissionMode ?? row.permissionMode,
    model: dto?.model ?? row.model,
    effort: dto?.effort ?? row.effort,
    remoteControl: dto?.remoteControl ?? row.remoteControl,
    currentActivity: dto ? dto.currentActivity : row.currentActivity,
    lastInstruction: dto ? dto.lastInstruction : row.lastInstruction,
    pendingPermissionId: dto?.pendingPermission?.status === 'pending' ? dto.pendingPermission.id : null,
    errorMessage: dto ? dto.errorMessage : row.errorMessage,
    planDone: dto ? dto.planDone : row.planDone,
    planTotal: dto ? dto.planTotal : row.planTotal,
    createdAt: row.createdAt.toISOString(),
    startedAt,
    endedAt,
    lastActivityAt: dto?.lastActivityAt ?? iso(row.lastActivityAt),
    archivedAt: iso(row.archivedAt),
    durationMs,
    // An archived session has no limit in play any more (its resumption is cancelled).
    limit: status === 'archived' ? null : dto && dto.limit !== undefined ? dto.limit : parseUsageLimit(row.usageLimit),
    autoResume: row.autoResume,
  };
}

// ---------------------------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------------------------

/**
 * A read overlay the runner could not give: unreachable (RUNNER_UNAVAILABLE), too slow or out of
 * contract (UPSTREAM). The database view stays, marked « non vérifié », instead of failing the
 * whole section. Writes keep their error.
 */
export function isRunnerUnverified(error: unknown): boolean {
  return isRunnerUnavailable(error) || (error instanceof AppError && error.code === 'UPSTREAM');
}

/** Live sessions of ONE server according to the database (its runner does not answer). */
export async function databaseLiveCount(environmentId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessions)
    .where(and(eq(sessions.environmentId, environmentId), inArray(sessions.status, [...LIVE_STATUSES]), isNull(sessions.archivedAt)));
  return Number(row?.n ?? 0);
}

/** Sessions allowed in parallel on a server (its row; `fallback` when it cannot be read). */
export async function environmentMaxSessions(environmentId: string, fallback: number): Promise<number> {
  const settings = await getEnvironmentSettings(environmentId);
  return settings?.maxConcurrentSessions ?? fallback;
}

/**
 * « 2 sessions actives sur 4 autorisées » on the server of the space: live CLI processes counted
 * by its runner (database fallback when it does not answer), limit of the server
 * (`environments.max_concurrent_sessions`). Without a server: `source: 'unassigned'`, 0 on 0.
 */
export async function getCapacity(ctx: Pick<RequestContext, 'environment'>): Promise<SessionCapacity> {
  const environment = ctx.environment;
  if (!environment) return { active: 0, max: 0, source: 'unassigned', environment: null };
  const server = { id: environment.id, name: environment.name };
  const max = await environmentMaxSessions(environment.id, environment.maxConcurrentSessions);
  try {
    const { capacity } = await getRunnerForEnvironment(environment.id).listSessions(undefined, { timeoutMs: 5_000 });
    return { active: capacity.live, max, source: 'runner', environment: server };
  } catch (error) {
    if (!isRunnerUnverified(error)) throw error;
    return { active: await databaseLiveCount(environment.id), max, source: 'database', environment: server };
  }
}

/** « 2 sessions actives sur 2 autorisées : arrêtez-en une… » (singular agreed: « 1 session active sur 1 autorisée »). */
export function capacityMessage(capacity: Pick<SessionCapacity, 'active' | 'max'>): string {
  return `${capacityTitle(capacity.active, capacity.max)} : arrêtez-en une avant d'en démarrer une autre.`;
}

// ---------------------------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------------------------

export interface ListSessionsInput {
  projectId?: string | null;
  /** `active` = D06 « EN COURS » (new + live), `history` = everything that no longer runs. */
  status: 'active' | 'history';
  /** History filter (D06 « Statut », M06 chips). */
  filter?: HistoryFilter;
  period?: HistoryPeriod;
  q?: string | null;
  cursor?: string | null;
  limit?: number;
}

interface Cursor {
  t: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') throw new Error('cursor');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(parsed.t) || Number.isNaN(Date.parse(parsed.t))) throw new Error('cursor');
    if (!/^[0-9a-f-]{36}$/i.test(parsed.id)) throw new Error('cursor');
    return { t: parsed.t, id: parsed.id };
  } catch {
    throw new AppError('VALIDATION', 'Curseur de pagination invalide.');
  }
}

/** `%` and `_` typed by the owner are literal characters, not wildcards. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function resumableSql(): SQL {
  return and(inArray(sessions.status, [...RESUMABLE_STATUSES]), isNull(projects.archivedAt), ne(projects.status, 'archived'))!;
}

function filterSql(filter: HistoryFilter): SQL {
  switch (filter) {
    case 'terminees':
      return eq(sessions.status, 'finished');
    case 'archivees':
      return eq(sessions.status, 'archived');
    case 'reprise-possible':
      return resumableSql();
    case 'reprise-impossible':
      // Only an archived project blocks a resumption now (worktree recreated, new context otherwise).
      return and(inArray(sessions.status, [...RESUMABLE_STATUSES]), or(isNotNull(projects.archivedAt), eq(projects.status, 'archived')))!;
    default:
      return inArray(sessions.status, [...HISTORY_STATUSES]);
  }
}

/**
 * Live DTOs of the runners of `environmentIds` (each asked once), by session id, limited to
 * `allowed` (a DTO of a session that is not a row of this space is ignored). null when one of them
 * does not answer.
 */
async function runnerLiveSessions(environmentIds: Iterable<string>, allowed: ReadonlySet<string>): Promise<Map<string, SessionDto> | null> {
  const result = new Map<string, SessionDto>();
  let reachable = true;
  await Promise.all(
    [...new Set(environmentIds)].map(async (environmentId) => {
      try {
        const { sessions: list } = await getRunnerForEnvironment(environmentId).listSessions(undefined, { timeoutMs: 5_000 });
        for (const dto of list) if (allowed.has(dto.id)) result.set(dto.id, dto);
      } catch (error) {
        if (isRunnerUnverified(error)) reachable = false;
        else throw error;
      }
    }),
  );
  return reachable ? result : null;
}

/**
 * Confirms « reprise possible » with the runner of each session's server (journal on disk); null
 * when one of them does not answer.
 */
async function confirmResumable(rows: ReadonlyArray<Pick<SessionRow, 'id' | 'environmentId'>>): Promise<Map<string, SessionDto> | null> {
  const result = new Map<string, SessionDto>();
  let reachable = true;
  await Promise.all(
    rows.map(async ({ id: sessionId, environmentId }) => {
      try {
        result.set(sessionId, await getRunnerForEnvironment(environmentId).getSession({ params: { sessionId } }, { timeoutMs: 5_000 }));
      } catch (error) {
        if (isRunnerUnverified(error)) reachable = false;
        // NOT_FOUND or anything else: the database view stays.
      }
    }),
  );
  return reachable ? result : null;
}

/**
 * D06 lists of the space: « EN COURS » (`status: 'active'`) or « HISTORIQUE » with its filters
 * (statut, période, projet, recherche) and its cursor.
 */
export async function listSessions(ctx: Pick<RequestContext, 'space' | 'environment'>, input: ListSessionsInput): Promise<SessionListPage> {
  const conditions: SQL[] = [];
  if (input.projectId) conditions.push(eq(sessions.projectId, input.projectId));
  const q = input.q?.trim();
  if (q) {
    const pattern = likePattern(q);
    conditions.push(
      or(
        ilike(sessions.title, pattern),
        ilike(projects.name, pattern),
        ilike(projects.githubFullName, pattern),
        ilike(worktrees.branch, pattern),
      )!,
    );
  }

  if (input.status === 'active') {
    conditions.push(inArray(sessions.status, [...ACTIVE_STATUSES]), isNull(sessions.archivedAt));
    const rows = (await baseQuery()
      .where(ofSpace(ctx, ...conditions))
      .orderBy(desc(startKey), desc(sessions.id))
      .limit(100)) as SessionRow[];
    // The servers of the rows, plus the space's own server (« non vérifié » while it is down).
    const servers = rows.map((row) => row.environmentId);
    if (ctx.environment) servers.push(ctx.environment.id);
    const live = await runnerLiveSessions(servers, new Set(rows.map((row) => row.id)));
    return {
      items: rows.map((row) => toListItem(row, live ? { dto: live.get(row.id) ?? null, live: live.get(row.id)?.live ?? false } : {})),
      nextCursor: null,
      verified: live !== null,
    };
  }

  const filter = input.filter ?? 'toutes';
  conditions.push(filterSql(filter));
  const days = HISTORY_PERIOD_DAYS[input.period ?? '30j'];
  // Raw expressions get no column mapping: dates are passed as ISO text, cast by PostgreSQL.
  if (days !== null) conditions.push(gte(startKey, timestamp(new Date(Date.now() - days * 86_400_000))));
  const limit = Math.min(Math.max(input.limit ?? HISTORY_PAGE_SIZE, 1), 100);
  // Only the runner knows whether a recorded conversation still exists on disk: the two « reprise »
  // filters are completed after its answer (a journal it cannot find moves the row from « possible »
  // to « impossible », like its badge). Rows are then read in batches until the page is full.
  const keep =
    filter === 'reprise-possible'
      ? (item: SessionListItem) => item.resumable
      : filter === 'reprise-impossible'
        ? (item: SessionListItem) => !item.resumable
        : null;
  const maxBatches = keep ? 5 : 1;

  let cursor = decodeCursor(input.cursor);
  const items: SessionListItem[] = [];
  let verified = true;
  let hasMore = false;
  for (let batch = 0; batch < maxBatches && items.length < limit; batch += 1) {
    const where = [...conditions];
    if (cursor) {
      const at = sql`${cursor.t}::timestamptz`;
      where.push(or(lt(startKey, at), and(eq(startKey, at), lt(sessions.id, cursor.id)))!);
    }
    const rows = (await baseQuery()
      .where(ofSpace(ctx, ...where))
      .orderBy(desc(startKey), desc(sessions.id))
      .limit(limit + 1)) as SessionRow[];
    const page = rows.slice(0, limit);
    const candidates = page.filter(resumableFromDatabase);
    const confirmed = candidates.length ? await confirmResumable(candidates) : new Map<string, SessionDto>();
    if (confirmed === null) verified = false;
    let consumed = 0;
    for (const row of page) {
      consumed += 1;
      const dto = confirmed?.get(row.id);
      const item = toListItem(row, dto ? { dto, resumable: dto.resumable } : { live: false });
      if (!keep || keep(item)) items.push(item);
      if (items.length >= limit) break;
    }
    const last = page[consumed - 1];
    hasMore = consumed < page.length || rows.length > limit;
    if (!last || !hasMore) break;
    cursor = { t: last.startKeyText ?? (last.startedAt ?? last.createdAt).toISOString(), id: last.id };
  }
  return { items, nextCursor: hasMore && cursor ? encodeCursor(cursor) : null, verified };
}

/** One session of the space (row + view of its server's runner when reachable). */
export async function getSessionItem(ctx: Pick<RequestContext, 'space'>, sessionId: string): Promise<SessionListItem> {
  const scope = await scopeOfSession(ctx, sessionId);
  return readSessionItem(ctx, scope.sessionId, scope.runner);
}

/** {@link getSessionItem} once the session is scoped (`runner` = the client of its server). */
export async function readSessionItem(ctx: Pick<RequestContext, 'space'>, sessionId: string, runner: RunnerClient): Promise<SessionListItem> {
  const [row] = (await baseQuery().where(ofSpace(ctx, eq(sessions.id, sessionId))).limit(1)) as SessionRow[];
  if (!row) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGES.session);
  try {
    const dto = await runner.getSession({ params: { sessionId } }, { timeoutMs: 5_000 });
    return toListItem(row, { dto });
  } catch (error) {
    if (isRunnerUnverified(error) || (error instanceof AppError && error.code === 'NOT_FOUND')) return toListItem(row);
    throw error;
  }
}

/** Projects of the space that have at least one session (D06 « Projet : tous » options). */
export async function listSessionProjects(ctx: Pick<RequestContext, 'space'>): Promise<Array<{ id: string; name: string }>> {
  return db
    .selectDistinct({ id: projects.id, name: projects.name })
    .from(projects)
    .innerJoin(sessions, eq(sessions.projectId, projects.id))
    .where(ofSpace(ctx))
    .orderBy(projects.name);
}

// ---------------------------------------------------------------------------------------------
// Summary (W3 « Résumé de fin de session », « Voir le résumé »)
// ---------------------------------------------------------------------------------------------

/** Bullet lines of Claude's final message, verbatim (`- x`, `* x`, `• x`, `1. x`). */
export function summaryPoints(message: string | null, max = 12): string[] {
  if (!message) return [];
  const points: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    const match = /^\s{0,3}(?:[-*•]|\d{1,2}[.)])\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) points.push(match[1]);
    if (points.length >= max) break;
  }
  return points;
}

/** W3 « Voir le résumé » of a session of the space. */
export async function getSessionSummary(ctx: Pick<RequestContext, 'space'>, sessionId: string): Promise<SessionSummary> {
  const scope = await scopeOfSession(ctx, sessionId);
  const session = await readSessionItem(ctx, scope.sessionId, scope.runner);
  const [final] = await db
    .select({ payload: sessionEvents.payload })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.kind, 'assistant')))
    .orderBy(desc(sessionEvents.position))
    .limit(1);
  const finalMessage = typeof final?.payload?.text === 'string' ? (final.payload.text as string) : null;
  const [counts] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.kind, 'instruction')));
  const [allowed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(permissionRequests)
    .where(and(eq(permissionRequests.sessionId, sessionId), inArray(permissionRequests.status, ['allowed', 'allowed_always'])));

  let changes: SessionSummary['changes'] = null;
  if (session.worktree?.present) {
    try {
      const result = await scope.runner.worktreeChanges({ params: { worktreeId: session.worktree.id } }, { timeoutMs: 8_000 });
      changes = { files: result.totals.files, additions: result.totals.insertions, deletions: result.totals.deletions };
    } catch {
      changes = null;
    }
  }
  return {
    session,
    finalMessage,
    points: summaryPoints(finalMessage),
    instructionCount: Number(counts?.n ?? 0),
    allowedCommands: Number(allowed?.n ?? 0),
    changes,
  };
}

