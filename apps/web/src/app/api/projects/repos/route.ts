import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { listAddProjectRepos, withProjectErrors } from '@/server/projects';

/**
 * GET /api/projects/repos?q=&compte=&source= — A1 « Choix du dépôt »: repositories the GitHub
 * sources of the space can read, grouped by account (and source), with « Déjà cloné » for the
 * projects of the space. `{ connected: false, message }` when GitHub is not connected (the step
 * shows the call to action towards Intégrations). `compte` filters on the account login,
 * `source` on the GitHub source.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  query: z.object({
    q: z.string().trim().max(200).optional(),
    compte: z.string().trim().max(100).optional(),
    source: z.string().trim().max(64).optional(),
  }),
  rateLimit: { limit: 120, windowMs: 60_000 },
  handler: ({ query, ctx }) =>
    withProjectErrors(async () => {
      const result = await listAddProjectRepos(ctx);
      if (!result.connected) return result;
      const q = query.q?.toLowerCase();
      const owner = query.compte?.toLowerCase();
      const source = query.source;
      const repos = result.repos.filter(
        (repo) =>
          (!q || repo.fullName.toLowerCase().includes(q)) &&
          (!owner || repo.owner.toLowerCase() === owner) &&
          (!source || repo.sources.some((item) => item.id === source)),
      );
      return { ...result, repos };
    }),
});
