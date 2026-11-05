import { TerminalInputRequestSchema } from '@nuera/shared/runner';
import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { runner } from '@/server/runner/client';
import { TERMINAL_ID_PATTERN } from '@/server/terminals';

/**
 * POST /api/terminals/[id]/input — `{ data }`: keystrokes typed in xterm.js, batched (~10 ms) and
 * sent one request at a time by the browser (`TerminalView`), so they reach the PTY in order.
 * The body is never logged (login terminals carry the code pasted by the owner). A lone Échap /
 * Ctrl+C in a session terminal counts as « Interrompre » on the runner. 409 once the terminal
 * has exited.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: z.object({ id: z.string().regex(TERMINAL_ID_PATTERN) }),
  body: TerminalInputRequestSchema,
  maxBodyBytes: 128 * 1024,
  handler: async ({ params, body }) => {
    await runner.terminalInput({ params: { terminalId: params.id }, body });
    return undefined;
  },
});
