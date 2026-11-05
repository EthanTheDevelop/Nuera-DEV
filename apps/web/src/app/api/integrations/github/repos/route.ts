import { z } from 'zod';
import { listAccessibleRepos } from '@/server/github';
import { apiRoute } from '@/server/http';

/**
 * GET /api/integrations/github/repos[?owner=&q=] — repositories the owner authorised (A1 « Choix du
 * dépôt »): grouped by account, « Déjà cloné » flag, counts for the chips (« Tous · 12 »).
 * `owner` and `q` filter the flat list; `accounts` always carries the full counts.
 */

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  owner: z.string().trim().max(39).optional(),
  q: z.string().trim().max(100).optional(),
});

export const GET = apiRoute({
  query: querySchema,
  rateLimit: { limit: 60, windowMs: 60_000 },
  handler: async ({ query }) => {
    const result = await listAccessibleRepos();
    const owner = query.owner?.toLowerCase();
    const q = query.q?.toLowerCase();
    if (!owner && !q) return result;
    const repos = result.repos.filter(
      (repo) => (!owner || repo.owner.toLowerCase() === owner) && (!q || repo.fullName.toLowerCase().includes(q)),
    );
    return { ...result, repos };
  },
});
