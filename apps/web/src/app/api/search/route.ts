import { apiRoute } from '@/server/http';
import { search, searchQuerySchema } from '@/server/search';

/**
 * GET /api/search?q=<texte>[&limite=6] — global search of the command palette (⌘K / Ctrl K):
 *   → { query, projects: [{ id, name, fullName, path, status, href }], sessions: [{ id, title, status,
 *       projectName, branch, href }], actions: [{ id, label, description, icon, href, keywords }] }
 * Signed-in account (apiRoute), results of its space only, Zod validation (1–120 characters),
 * rate limit per IP, bounded results, database only.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  query: searchQuerySchema,
  rateLimit: { limit: 240, windowMs: 60_000 },
  handler: async ({ query, ctx }) => {
    const results = await search(ctx, query.q, query.limite);
    return Response.json(results, { headers: { 'cache-control': 'no-store' } });
  },
});
