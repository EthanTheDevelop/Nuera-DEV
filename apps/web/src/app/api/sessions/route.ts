import { apiRoute } from '@/server/http';
import { createSession, createSessionInputSchema, listSessions, listSessionsQuerySchema } from '@/server/sessions';

/**
 * POST /api/sessions — « Nouvelle session » (W1): worktree + session created by the runner, the
 * CLI starts at the first instruction (sent right away when `instruction` is given).
 *   { projectId, title?, branch: { mode: 'new', branch, base? } | { mode: 'existing', branch } | { mode: 'primary' },
 *     permissionMode?, model?, effort?, remoteControl?, instruction? }
 *   → 201 { sessionId, workspaceUrl, instruction, instructionError }
 * GET /api/sessions?statut=active|history&projet=&filtre=&periode=&q=&curseur=&limite=
 *   → { items, nextCursor, verified }
 * Session + Origin check (apiRoute), Zod validation, rate limit on creation, audit `session.create`.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  body: createSessionInputSchema,
  maxBodyBytes: 256 * 1024,
  rateLimit: { limit: 20, windowMs: 10 * 60_000 },
  handler: async ({ body, ctx }) => {
    const result = await createSession(ctx, body);
    return Response.json(result, { status: 201, headers: { 'cache-control': 'no-store' } });
  },
});

export const GET = apiRoute({
  query: listSessionsQuerySchema,
  rateLimit: { limit: 240, windowMs: 60_000 },
  handler: async ({ query, ctx }) =>
    listSessions(ctx, {
      status: query.statut,
      projectId: query.projet ?? null,
      filter: query.filtre,
      period: query.periode,
      q: query.q ?? null,
      cursor: query.curseur ?? null,
      ...(query.limite ? { limit: query.limite } : {}),
    }),
});
