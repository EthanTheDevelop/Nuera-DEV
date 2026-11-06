import { apiRoute } from '@/server/http';
import { openTerminal, openTerminalInputSchema } from '@/server/terminals';

/**
 * POST /api/terminals — opens a terminal for the browser (xterm.js `TerminalView`) on the server of
 * the account's space (a shell: in a worktree of the space; login and /status: owner of the space only):
 *   { kind: 'shell', worktreeId, cols?, rows? }   shell in an active worktree
 *   { kind: 'claude-login', cols?, rows? }        `claude auth login` (private: never recorded)
 *   { kind: 'claude-status', cols?, rows? }       interactive CLI in a scratch folder, the owner types /status
 * → 201 { terminal: TerminalDto }. The browser then reads /api/stream/terminals/<id> and types into
 * /api/terminals/<id>/input. MCP logins: POST /api/integrations/mcp/[server]/login. Session
 * terminals: created by the session itself.
 * Session + Origin check (apiRoute), Zod validation, audit `terminal.open`, per-kind rate limits
 * (server/terminals) plus this per-IP safety net.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  body: openTerminalInputSchema,
  maxBodyBytes: 4 * 1024,
  rateLimit: { limit: 60, windowMs: 10 * 60_000 },
  handler: async ({ body, ctx }) => {
    const terminal = await openTerminal(ctx, body);
    return Response.json({ terminal }, { status: 201, headers: { 'cache-control': 'no-store' } });
  },
});
