import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { isRunnerUnavailable, proxyRunnerStream, runnerUnavailableStream } from '@/server/runner/client';
import { scopeOfTerminal, TERMINAL_ID_PATTERN } from '@/server/tenancy/scope';

/**
 * GET /api/stream/terminals/[id] — bytes of a PTY: `terminal.snapshot` (serialized screen +
 * scrollback, always first, also after every reconnection: no replay, no `id:`), then
 * `terminal.data`, `terminal.resize`, `terminal.exit`, and `heartbeat` every 15 s. Write
 * `snapshot.data` (at the snapshot's size) then each `data` chunk into xterm.js as they are —
 * `TerminalView` (`@/components/terminal`) does it. The terminal must be one of the account's,
 * on the server of its space (404 « Terminal introuvable ou fermé. » otherwise); 404 as well once
 * the terminal is closed or forgotten; `stream.error` (RUNNER_UNAVAILABLE) when the runner cannot
 * be reached — also while checking the terminal, which lives on the runner only.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: z.object({ id: z.string().regex(TERMINAL_ID_PATTERN) }),
  handler: async ({ request, params, ctx }) => {
    let scope: Awaited<ReturnType<typeof scopeOfTerminal>>;
    try {
      scope = await scopeOfTerminal(ctx, params.id);
    } catch (error) {
      // ctx has a server here (otherwise NOT_FOUND): the terminal connection shows T5 and retries.
      if (isRunnerUnavailable(error) && ctx.environment) return runnerUnavailableStream(ctx.environment.name);
      throw error;
    }
    return proxyRunnerStream(request, await scope.endpoint(), `/v1/terminals/${scope.terminalId}/stream`);
  },
});
