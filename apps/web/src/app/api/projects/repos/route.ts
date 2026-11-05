import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { listAddProjectRepos } from '@/server/projects';

/**
 * GET /api/projects/repos?q=&compte= — A1 « Choix du dépôt »: repositories the GitHub App can read,
 * grouped by account, with « Déjà cloné ». `{ connected: false, message }` when GitHub is not
 * connected (the step shows the call to action towards Intégrations).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  query: z.object({ q: z.string().trim().max(200).optional(), compte: z.string().trim().max(100).optional() }),
  rateLimit: { limit: 120, windowMs: 60_000 },
  handler: async ({ query }) => {
    const result = await listAddProjectRepos();
    if (!result.connected) return result;
    const q = query.q?.toLowerCase();
    const owner = query.compte?.toLowerCase();
    const repos = result.repos.filter(
      (repo) => (!q || repo.fullName.toLowerCase().includes(q)) && (!owner || repo.owner.toLowerCase() === owner),
    );
    return { ...result, repos };
  },
});
