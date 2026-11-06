import 'server-only';
import { environments, operations, projects, sessions, worktrees } from '@nuera/db/schema';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { OperationLogItem, SessionLogItem } from '@/features/settings/lib/types';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import type { RequestContext } from '@/server/tenancy/context';
import { NOT_FOUND_MESSAGES, ofSpace, scopeOfOperation } from '@/server/tenancy/scope';
import { iso } from './load';

/**
 * « Journaux » (D08 Maintenance · Consulter): the journals Nuera Dev really keeps — Git operations
 * (`operations`: clone, fetch, pull, commit, push, PR…, journal masked by the runner) and the end of
 * Claude sessions (`sessions`: status, CLI error). Read-only, and only those of the account's space:
 * operations on a server of the space (of a project of the space, or without project), sessions of
 * the projects of the space. An operation of another space answers exactly like an unknown one.
 */

const MAX_LOG_CHARS = 64 * 1024;

export async function listOperationLogs(ctx: Pick<RequestContext, 'space'>, limit = 40): Promise<OperationLogItem[]> {
  const rows = await db
    .select({
      id: operations.id,
      kind: operations.kind,
      status: operations.status,
      title: operations.title,
      projectName: projects.name,
      createdAt: operations.createdAt,
      finishedAt: operations.finishedAt,
      error: operations.error,
      logLength: sql<number>`length(${operations.log})`,
    })
    .from(operations)
    .innerJoin(environments, eq(environments.id, operations.environmentId))
    .leftJoin(projects, eq(projects.id, operations.projectId))
    .where(and(eq(environments.spaceId, ctx.space.id), or(isNull(operations.projectId), eq(projects.spaceId, ctx.space.id))))
    .orderBy(desc(operations.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    projectName: row.projectName ?? null,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    finishedAt: iso(row.finishedAt),
    errorMessage: row.error?.message ?? null,
    hasLog: Number(row.logLength ?? 0) > 0 || Boolean(row.error?.raw),
  }));
}

/**
 * Journal of one operation (+ raw error output), shown « à un clic ». Scoped first: an operation of
 * another space, an unknown id and a malformed id all answer NOT_FOUND « Opération introuvable. ».
 */
export async function getOperationLog(ctx: Pick<RequestContext, 'space'>, id: string): Promise<{ log: string; raw: string | null }> {
  const scope = await scopeOfOperation(ctx, typeof id === 'string' ? id : '');
  const [row] = await db
    .select({ log: operations.log, error: operations.error })
    .from(operations)
    .where(eq(operations.id, scope.operationId))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGES.operation);
  return { log: row.log.slice(-MAX_LOG_CHARS), raw: row.error?.raw?.slice(-MAX_LOG_CHARS) ?? null };
}

const ENDED = ['stopped', 'interrupted', 'failed', 'finished', 'archived'] as const;

export async function listSessionLogs(ctx: Pick<RequestContext, 'space'>, limit = 40): Promise<SessionLogItem[]> {
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      status: sessions.status,
      projectName: projects.name,
      branch: worktrees.branch,
      endedAt: sessions.endedAt,
      lastActivityAt: sessions.lastActivityAt,
      errorCode: sessions.errorCode,
      errorMessage: sessions.errorMessage,
    })
    .from(sessions)
    .innerJoin(projects, and(eq(projects.id, sessions.projectId), eq(projects.environmentId, sessions.environmentId)))
    .leftJoin(worktrees, eq(worktrees.id, sessions.worktreeId))
    .where(ofSpace(ctx, inArray(sessions.status, [...ENDED])))
    .orderBy(desc(sessions.updatedAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    projectName: row.projectName ?? null,
    branch: row.branch ?? null,
    endedAt: iso(row.endedAt),
    lastActivityAt: iso(row.lastActivityAt),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  }));
}
