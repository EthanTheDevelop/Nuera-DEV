import { apiRoute } from '@/server/http';
import { archiveSession, getSessionSummary, renameSession, renameSessionInputSchema, sessionIdParamsSchema } from '@/server/sessions';

/**
 * GET /api/sessions/[sessionId] → SessionSummary (session row + runner view, Claude's final
 * message verbatim, permission log count, uncommitted changes when the runner answers).
 * PATCH { title } → rename (audited) · DELETE → archive (refused while a CLI runs; audited).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: sessionIdParamsSchema,
  // Reads the worktree's changes through the runner (git status): bounded like the list.
  rateLimit: { limit: 240, windowMs: 60_000 },
  handler: async ({ params, ctx }) => getSessionSummary(ctx, params.sessionId),
});

export const PATCH = apiRoute({
  params: sessionIdParamsSchema,
  body: renameSessionInputSchema,
  maxBodyBytes: 8 * 1024,
  rateLimit: { limit: 60, windowMs: 10 * 60_000 },
  handler: async ({ params, body, ctx }) => renameSession(ctx, params.sessionId, body.title),
});

export const DELETE = apiRoute({
  params: sessionIdParamsSchema,
  rateLimit: { limit: 60, windowMs: 10 * 60_000 },
  handler: async ({ params, ctx }) => archiveSession(ctx, params.sessionId),
});
