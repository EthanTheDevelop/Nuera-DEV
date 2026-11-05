import 'server-only';
import { projects } from '@nuera/db/schema';
import { and, asc, eq, ilike, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { runner } from '@/server/runner/client';
import { operationStateByProject, sessionCountsByProject, toListItem } from './queries';
import { PROJECT_FILTERS, PROJECT_SORTS, type DiskUsage, type ProjectListItem, type ProjectListResult } from './types';

export const listProjectsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  filtre: z.enum(PROJECT_FILTERS).optional(),
  tri: z.enum(PROJECT_SORTS).optional(),
});

export interface ListProjectsOptions {
  /** Name, `owner/repo` or path (case-insensitive). */
  q?: string | undefined;
  /** D02 chips; default « tous » (non-archived). */
  filter?: (typeof PROJECT_FILTERS)[number] | undefined;
  sort?: (typeof PROJECT_SORTS)[number] | undefined;
  /** Adds archived projects to « tous » (default false: « Archivés » is its own chip). */
  includeArchived?: boolean;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Disk of the projects root, from the runner (short timeout: the list never waits for VPS-3). */
export async function getProjectsDisk(): Promise<{ disk: DiskUsage | null; available: boolean }> {
  try {
    const metrics = await runner.systemMetrics(undefined, { timeoutMs: 4_000 });
    return { disk: metrics.disk ? { usedBytes: metrics.disk.usedBytes, totalBytes: metrics.disk.totalBytes, freeBytes: metrics.disk.freeBytes } : null, available: true };
  } catch {
    return { disk: null, available: false };
  }
}

const sortItems = (items: ProjectListItem[], sort: ListProjectsOptions['sort']) => {
  const byActivity = (a: ProjectListItem, b: ProjectListItem) =>
    Date.parse(b.lastActivityAt ?? b.createdAt) - Date.parse(a.lastActivityAt ?? a.createdAt);
  const compare =
    sort === 'nom'
      ? (a: ProjectListItem, b: ProjectListItem) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })
      : sort === 'ajout'
        ? (a: ProjectListItem, b: ProjectListItem) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
        : byActivity;
  // Favourites first (D02, M02), then the chosen order.
  return items.sort((a, b) => Number(b.favorite) - Number(a.favorite) || compare(a, b));
};

/**
 * D02 / M02: projects with their sync badge, sessions summary, last activity and running operation,
 * the chip counters and the disk of the projects root. DB only, plus one bounded runner call for
 * the disk (null when VPS-3 does not answer: the list still renders).
 */
export async function listProjects(options: ListProjectsOptions = {}): Promise<ProjectListResult> {
  const filter = options.filter ?? 'tous';
  const where: SQL[] = [];
  if (filter === 'archives') where.push(isNotNull(projects.archivedAt));
  else if (!options.includeArchived) where.push(isNull(projects.archivedAt));
  if (filter === 'favoris') where.push(eq(projects.isFavorite, true));
  const q = options.q?.trim();
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    where.push(or(ilike(projects.name, pattern), ilike(projects.githubFullName, pattern), ilike(projects.path, pattern))!);
  }

  const [rows, countRows, disk] = await Promise.all([
    db.select().from(projects).where(and(...where)).orderBy(asc(projects.createdAt)).limit(500),
    db
      .select({
        all: sql<number>`count(*) filter (where ${projects.archivedAt} is null)::int`,
        favorites: sql<number>`count(*) filter (where ${projects.archivedAt} is null and ${projects.isFavorite})::int`,
        archived: sql<number>`count(*) filter (where ${projects.archivedAt} is not null)::int`,
      })
      .from(projects),
    getProjectsDisk(),
  ]);
  const ids = rows.map((row) => row.id);
  const [counts, ops] = await Promise.all([sessionCountsByProject(ids), operationStateByProject(ids)]);
  const items = sortItems(
    rows.map((row) => toListItem(row, counts.get(row.id), ops.get(row.id))),
    options.sort,
  );
  const c = countRows[0];
  return {
    items,
    counts: { all: Number(c?.all ?? 0), favorites: Number(c?.favorites ?? 0), archived: Number(c?.archived ?? 0) },
    disk: disk.disk,
    runnerAvailable: disk.available,
  };
}
