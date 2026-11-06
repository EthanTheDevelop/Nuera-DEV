import { TerminalResizeRequestSchema } from '@nuera/shared/runner';
import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { resizeTerminal, TERMINAL_ID_PATTERN } from '@/server/terminals';

/**
 * POST /api/terminals/[id]/resize — `{ cols, rows, clientId? }` (clientId = one id per browser tab).
 * The last client that resizes wins; every viewer receives `terminal.resize` and follows.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: z.object({ id: z.string().regex(TERMINAL_ID_PATTERN) }),
  body: TerminalResizeRequestSchema,
  maxBodyBytes: 4 * 1024,
  rateLimit: { limit: 600, windowMs: 60_000 },
  handler: async ({ params, body, ctx }) => {
    await resizeTerminal(ctx, params.id, body);
    return undefined;
  },
});
