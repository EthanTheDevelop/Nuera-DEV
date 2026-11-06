import { getMyClaudeConfig, listMyProposals } from '@/server/claude-config';
import { apiRoute } from '@/server/http';

/**
 * GET → { config: MyClaudeConfigView, proposals } — the common configuration that applies to the
 * account (items outside its audience are left out), the copy on its server, its own proposals.
 */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  handler: async ({ ctx }) => ({ config: await getMyClaudeConfig(ctx), proposals: await listMyProposals(ctx.user) }),
});
