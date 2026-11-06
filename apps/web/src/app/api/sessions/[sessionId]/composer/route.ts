import { sessionParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { getComposerPalette, withWorkspaceErrors } from '@/server/workspace';

/**
 * GET /api/sessions/[sessionId]/composer — data of the palette « / » and of the model chip: skills of
 * the worktree and of the CLI config dir (runner, read-only), MCP servers enabled for the project
 * (tools of their last diagnostic), models (aliases + those the CLI reported in the space).
 * → { skills, skillsError, mcp, models }
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: sessionParamsSchema,
  rateLimit: { limit: 120, windowMs: 10 * 60_000 },
  handler: ({ params, ctx }) =>
    withWorkspaceErrors(() => getComposerPalette(ctx, params.sessionId)),
});
