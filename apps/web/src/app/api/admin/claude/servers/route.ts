import { listServerCopies } from '@/server/claude-config';
import { apiRoute } from '@/server/http';

/**
 *   GET  → { servers: ServerCopyView[] } copy of the common configuration held by each server in service
 *   POST → same, after asking every runner to fetch and write it now (« Synchroniser les serveurs »)
 * Administrators see revision, date and conflicting skill names only, never the content of a space.
 */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({ auth: 'admin', handler: async ({ user }) => ({ servers: await listServerCopies(user) }) });
export const POST = apiRoute({
  auth: 'admin',
  rateLimit: { limit: 10, windowMs: 60_000 },
  handler: async ({ user }) => ({ servers: await listServerCopies(user, { sync: true }) }),
});
