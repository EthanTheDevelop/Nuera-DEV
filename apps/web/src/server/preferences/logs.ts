import 'server-only';
import { operations, projects, sessions, worktrees } from '@nuera/db/schema';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { OperationLogItem, SessionLogItem } from '@/features/settings/lib/types';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { iso } from './load';

/**
 * « Journaux » (D08 Maintenance · Consulter): the journals Nuera Dev really keeps — Git operations
 * (`operations`: clone, fetch, pull, commit, push, PR…, journal masked by the runner) and the end of
 * Claude sessions (`sessions`: status, CLI error). Read-only.
 */

const MAX_LOG_CHARS = 64 * 1024;

export async function listOperationLogs(limit = 40): Promise<OperationLogItem[]> {
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
    .leftJoin(projects, eq(projects.id, operations.projectId))
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

export const operationIdSchema = z.uuid('opération invalide');

/** Journal of one operation (+ raw error output), shown « à un clic ». */
export async function getOperationLog(id: string): Promise<{ log: string; raw: string | null }> {
  const parsed = operationIdSchema.safeParse(id);
  if (!parsed.success) throw new AppError('VALIDATION', 'Opération invalide.');
  const [row] = await db.select({ log: operations.log, error: operations.error }).from(operations).where(eq(operations.id, parsed.data)).limit(1);
  if (!row) throw new AppError('NOT_FOUND', 'Opération introuvable.');
  return { log: row.log.slice(-MAX_LOG_CHARS), raw: row.error?.raw?.slice(-MAX_LOG_CHARS) ?? null };
}

const ENDED = ['stopped', 'interrupted', 'failed', 'finished', 'archived'] as const;

export async function listSessionLogs(limit = 40): Promise<SessionLogItem[]> {
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
    .leftJoin(projects, eq(projects.id, sessions.projectId))
    .leftJoin(worktrees, eq(worktrees.id, sessions.worktreeId))
    .where(inArray(sessions.status, [...ENDED]))
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
