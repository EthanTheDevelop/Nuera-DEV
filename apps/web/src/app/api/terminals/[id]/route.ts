import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { TERMINAL_ID_PATTERN, closeTerminal, getTerminal } from '@/server/terminals';

/**
 * GET /api/terminals/[id] — `{ terminal: TerminalDto }` (alive, exit code, size, kind…), any kind
 * including a session's; 404 once the terminal is closed or forgotten by the runner, and for a
 * terminal of another account (same answer as an unknown one).
 * DELETE /api/terminals/[id] — closes a terminal (shell, login, /status, MCP login); idempotent
 * (204 even if it was already gone, or is not one of this account: nothing is touched then). A
 * session terminal is refused (409): stop the session instead. Login terminals drop their
 * scrollback on close.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const params = z.object({ id: z.string().regex(TERMINAL_ID_PATTERN) });

export const GET = apiRoute({
  params,
  handler: async ({ params: { id }, ctx }) => ({ terminal: await getTerminal(ctx, id) }),
});

export const DELETE = apiRoute({
  params,
  handler: async ({ params: { id }, ctx }) => {
    await closeTerminal(ctx, id);
    return undefined;
  },
});
