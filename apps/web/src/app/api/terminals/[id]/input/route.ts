import { TerminalInputRequestSchema } from '@nuera/shared/runner';
import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { sendTerminalInput, TERMINAL_ID_PATTERN } from '@/server/terminals';

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
  // Keystrokes (one request per ~10 ms batch while typing): no window, the terminal must exist.
  rateLimit: false,
  handler: async ({ params, body, ctx }) => {
    await sendTerminalInput(ctx, params.id, body);
    return undefined;
  },
});
