import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { proxyRunnerStream } from '@/server/runner/client';
import { TERMINAL_ID_PATTERN } from '@/server/terminals';

/**
 * GET /api/stream/terminals/[id] — bytes of a PTY: `terminal.snapshot` (serialized screen +
 * scrollback, always first, also after every reconnection: no replay, no `id:`), then
 * `terminal.data`, `terminal.resize`, `terminal.exit`, and `heartbeat` every 15 s. Write
 * `snapshot.data` (at the snapshot's size) then each `data` chunk into xterm.js as they are —
 * `TerminalView` (`@/components/terminal`) does it. 404 once the terminal is closed or forgotten;
 * `stream.error` (RUNNER_UNAVAILABLE) when the runner cannot be reached.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: z.object({ id: z.string().regex(TERMINAL_ID_PATTERN) }),
  handler: ({ request, params }) => proxyRunnerStream(request, `/v1/terminals/${params.id}/stream`),
});
