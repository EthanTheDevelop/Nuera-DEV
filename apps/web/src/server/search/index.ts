import 'server-only';
import { projects, sessions, worktrees } from '@nuera/db/schema';
import { and, asc, desc, eq, ilike, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { SEARCH_ACTIONS, matchActions, normalizeQuery, type SearchResults } from '@/features/search/contract';

export type { SearchResults } from '@/features/search/contract';

/**
 * Global search of the command palette (⌘K / Ctrl K): projects (name, repository, path), sessions
 * (title, project, branch) and navigation actions. Database only (no runner, no GitHub), bounded.
 *
 *   const results = await search('devis');   // GET /api/search?q=devis
 */

export const SEARCH_QUERY_MAX = 120;
export const SEARCH_LIMIT = 6;

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'recherche vide').max(SEARCH_QUERY_MAX, `${SEARCH_QUERY_MAX} caractères au maximum`),
  limite: z.coerce.number().int().min(1).max(20).optional(),
});

/** `%` and `_` typed by the owner are literal characters. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function search(query: string, limit = SEARCH_LIMIT): Promise<SearchResults> {
  const q = normalizeQuery(query).slice(0, SEARCH_QUERY_MAX);
  if (!q) return { query: '', projects: [], sessions: [], actions: [] };
  const pattern = likePattern(q);
  const n = Math.min(Math.max(limit, 1), 20);

  const [projectRows, sessionRows] = await Promise.all([
    db
      .select({
        id: projects.id,
        name: projects.name,
        fullName: projects.githubFullName,
        path: projects.path,
        status: projects.status,
        archivedAt: projects.archivedAt,
      })
      .from(projects)
      .where(or(ilike(projects.name, pattern), ilike(projects.githubFullName, pattern), ilike(projects.path, pattern), ilike(projects.slug, pattern)))
      // Active projects first, exact name prefix before a match inside the path.
      .orderBy(sql`${projects.archivedAt} is not null`, sql`${projects.name} ilike ${`${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} desc`, asc(projects.name))
      .limit(n),
    db
      .select({
        id: sessions.id,
        title: sessions.title,
        status: sessions.status,
        projectName: projects.name,
        branch: worktrees.branch,
        lastActivityAt: sessions.lastActivityAt,
        createdAt: sessions.createdAt,
      })
      .from(sessions)
      .innerJoin(projects, eq(projects.id, sessions.projectId))
      .leftJoin(worktrees, eq(worktrees.id, sessions.worktreeId))
      .where(
        and(
          or(ilike(sessions.title, pattern), ilike(projects.name, pattern), ilike(worktrees.branch, pattern)),
          ne(sessions.status, 'archived'),
          isNull(sessions.archivedAt),
        ),
      )
      .orderBy(desc(sql`coalesce(${sessions.lastActivityAt}, ${sessions.startedAt}, ${sessions.createdAt})`))
      .limit(n),
  ]);

  return {
    query: q,
    projects: projectRows.map((row) => ({
      id: row.id,
      name: row.name,
      fullName: row.fullName,
      path: row.path,
      status: row.archivedAt ? 'archived' : row.status,
      href: `/projets/${row.id}`,
    })),
    sessions: sessionRows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      projectName: row.projectName,
      branch: row.branch,
      href: `/workspace/${row.id}`,
    })),
    actions: matchActions(q, SEARCH_ACTIONS).slice(0, n),
  };
}
