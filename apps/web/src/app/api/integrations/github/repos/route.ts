import { z } from 'zod';
import { listAccessibleRepos } from '@/server/github';
import { apiRoute } from '@/server/http';

/**
 * GET /api/integrations/github/repos[?owner=&q=&source=] — repositories the space authorised (A1
 * « Choix du dépôt »): every GitHub source of the space, one entry per repository (`sources` lists
 * every source that reaches it), grouped by account, « Déjà cloné » flag of the space, counts for the
 * chips (« Tous · 12 »), `failures` for a source that could not be listed. `owner` and `q` filter
 * the flat list; `accounts` always carries the full counts; `source` limits to one source of the
 * space (another space's id answers like an unknown one).
 */

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  owner: z.string().trim().max(39).optional(),
  q: z.string().trim().max(100).optional(),
  source: z.string().trim().max(64).optional(),
});

export const GET = apiRoute({
  query: querySchema,
  rateLimit: { limit: 60, windowMs: 60_000 },
  handler: async ({ query, ctx }) => {
    const result = await listAccessibleRepos({ spaceId: ctx.space.id, ...(query.source ? { sourceId: query.source } : {}) });
    const owner = query.owner?.toLowerCase();
    const q = query.q?.toLowerCase();
    if (!owner && !q) return result;
    const repos = result.repos.filter(
      (repo) => (!owner || repo.owner.toLowerCase() === owner) && (!q || repo.fullName.toLowerCase().includes(q)),
    );
    return { ...result, repos };
  },
});
