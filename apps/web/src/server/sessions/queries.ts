import 'server-only';
import { permissionRequests, projects, sessionEvents, sessions, worktrees } from '@nuera/db/schema';
import type { SessionDto } from '@nuera/shared/runner';
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
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
import { isRunnerUnavailable, runner } from '@/server/runner/client';
import { getAppSettings } from '@/server/settings';

/**
 * Read side of the sessions lot: lists (D06 « EN COURS », « HISTORIQUE »), capacity, summary.
 * The database is the source; the runner (when it answers) confirms what only it knows: which
 * CLI is alive and whether a stopped conversation can really be resumed (journal on disk).
 */

const RESUMABLE_STATUSES = ['interrupted', 'stopped', 'failed'] as const satisfies readonly SessionStatus[];

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
  worktreeId: worktrees.id,
  worktreeName: worktrees.name,
  worktreeBranch: worktrees.branch,
  worktreeIsPrimary: worktrees.isPrimary,
  worktreeStatus: worktrees.status,
  worktreeRemovedAt: worktrees.removedAt,
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
  worktreeId: string | null;
  worktreeName: string | null;
  worktreeBranch: string | null;
  worktreeIsPrimary: boolean | null;
  worktreeStatus: string | null;
  worktreeRemovedAt: Date | null;
  startKeyText?: string;
};

const startKey = sql<Date>`coalesce(${sessions.startedAt}, ${sessions.createdAt})`;
const timestamp = (date: Date) => sql`${date.toISOString()}::timestamptz`;

function baseQuery() {
  return db
    .select(columns)
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .leftJoin(worktrees, eq(worktrees.id, sessions.worktreeId));
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

function worktreePresent(row: SessionRow): boolean {
  return Boolean(row.worktreeId && row.worktreeStatus === 'active' && !row.worktreeRemovedAt);
}

/** « Reprise possible » as far as the database can tell (the runner also checks the journal on disk). */
export function resumableFromDatabase(row: SessionRow): boolean {
  return (
    (RESUMABLE_STATUSES as readonly SessionStatus[]).includes(row.status) &&
    Boolean(row.transcriptPath) &&
    worktreePresent(row) &&
    !row.projectArchivedAt
  );
}

export function resumeBlockedReason(row: SessionRow, resumable: boolean): ResumeBlockedReason | null {
  if (resumable) return null;
  if (row.status === 'archived') return 'archived';
  if (!(RESUMABLE_STATUSES as readonly SessionStatus[]).includes(row.status)) return null;
  if (row.projectArchivedAt) return 'project_archived';
  if (!worktreePresent(row)) return 'worktree_removed';
  return 'not_recorded';
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
  };
}

// ---------------------------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------------------------

async function databaseLiveCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessions)
    .where(and(inArray(sessions.status, [...LIVE_STATUSES]), isNull(sessions.archivedAt)));
  return Number(row?.n ?? 0);
}

/**
 * « 2 sessions actives sur 4 autorisées »: live CLI processes counted by the runner (database
 * fallback when it does not answer), limit from Paramètres (app_settings.maxConcurrentSessions).
 */
export async function getCapacity(): Promise<SessionCapacity> {
  const settings = await getAppSettings();
  try {
    const { capacity } = await runner.listSessions(undefined, { timeoutMs: 5_000 });
    return { active: capacity.live, max: settings.maxConcurrentSessions, source: 'runner' };
  } catch (error) {
    if (!isRunnerUnavailable(error)) throw error;
    return { active: await databaseLiveCount(), max: settings.maxConcurrentSessions, source: 'database' };
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
  return and(
    inArray(sessions.status, [...RESUMABLE_STATUSES]),
    isNotNull(sessions.transcriptPath),
    eq(worktrees.status, 'active'),
    isNull(worktrees.removedAt),
    isNull(projects.archivedAt),
  )!;
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
      // Every stopped conversation: the runner's answer decides (listSessions keeps the non-resumable ones).
      return inArray(sessions.status, [...RESUMABLE_STATUSES]);
    default:
      return inArray(sessions.status, [...HISTORY_STATUSES]);
  }
}

/** Live DTOs of the runner by id (null when it does not answer). */
async function runnerLiveSessions(): Promise<Map<string, SessionDto> | null> {
  try {
    const { sessions: list } = await runner.listSessions(undefined, { timeoutMs: 5_000 });
    return new Map(list.map((dto) => [dto.id, dto]));
  } catch (error) {
    if (isRunnerUnavailable(error)) return null;
    throw error;
  }
}

/** Confirms « reprise possible » with the runner (journal on disk); null when it does not answer. */
async function confirmResumable(ids: string[]): Promise<Map<string, SessionDto> | null> {
  const result = new Map<string, SessionDto>();
  let reachable = true;
  await Promise.all(
    ids.map(async (sessionId) => {
      try {
        result.set(sessionId, await runner.getSession({ params: { sessionId } }, { timeoutMs: 5_000 }));
      } catch (error) {
        if (isRunnerUnavailable(error)) reachable = false;
        // NOT_FOUND or anything else: the database view stays.
      }
    }),
  );
  return reachable ? result : null;
}

export async function listSessions(input: ListSessionsInput): Promise<SessionListPage> {
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
      .where(and(...conditions))
      .orderBy(desc(startKey), desc(sessions.id))
      .limit(100)) as SessionRow[];
    const live = await runnerLiveSessions();
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
      .where(and(...where))
      .orderBy(desc(startKey), desc(sessions.id))
      .limit(limit + 1)) as SessionRow[];
    const page = rows.slice(0, limit);
    const candidates = page.filter(resumableFromDatabase).map((row) => row.id);
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

/** One session (row + runner view when reachable). */
export async function getSessionItem(sessionId: string): Promise<SessionListItem> {
  const [row] = (await baseQuery().where(eq(sessions.id, sessionId)).limit(1)) as SessionRow[];
  if (!row) throw new AppError('NOT_FOUND', 'Session introuvable.');
  try {
    const dto = await runner.getSession({ params: { sessionId } }, { timeoutMs: 5_000 });
    return toListItem(row, { dto });
  } catch (error) {
    if (isRunnerUnavailable(error) || (error instanceof AppError && error.code === 'NOT_FOUND')) return toListItem(row);
    throw error;
  }
}

/** Projects that have at least one session (D06 « Projet : tous » options). */
export async function listSessionProjects(): Promise<Array<{ id: string; name: string }>> {
  return db
    .selectDistinct({ id: projects.id, name: projects.name })
    .from(projects)
    .innerJoin(sessions, eq(sessions.projectId, projects.id))
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

export async function getSessionSummary(sessionId: string): Promise<SessionSummary> {
  const session = await getSessionItem(sessionId);
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
      const result = await runner.worktreeChanges({ params: { worktreeId: session.worktree.id } }, { timeoutMs: 8_000 });
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

