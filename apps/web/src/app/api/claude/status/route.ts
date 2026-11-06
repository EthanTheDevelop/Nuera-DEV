import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { getClaudeCli } from '@/server/preferences';

/**
 * GET /api/claude/status[?refresh=1] → ClaudeCliView of the account's server: `claude --version` +
 * `claude auth status --json` as its runner reports them (whitelisted fields, no credential ever
 * read). `refresh=1` makes the runner run the CLI again (rate-limited: it spawns a process on the
 * server). Without a server: 409 « Aucun serveur ne vous est encore attribué… » (reason
 * NO_ENVIRONMENT), no runner call.
 */

export const dynamic = 'force-dynamic';

const querySchema = z.object({ refresh: z.enum(['0', '1', 'true', 'false']).optional() });

export const GET = apiRoute({
  query: querySchema,
  rateLimit: { limit: 30, windowMs: 60_000 },
  handler: async ({ query, ctx }) => getClaudeCli(ctx, { refresh: query.refresh === '1' || query.refresh === 'true' }),
});
