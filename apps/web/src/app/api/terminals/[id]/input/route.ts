import { TerminalInputRequestSchema } from '@nuera/shared/runner';
import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { runner } from '@/server/runner/client';

/**
 * POST /api/terminals/[id]/input — keystrokes typed in xterm.js (batched ~10 ms by the browser).
 * The body is never logged (login terminals carry the code pasted by the owner).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }),
  body: TerminalInputRequestSchema,
  maxBodyBytes: 128 * 1024,
  handler: async ({ params, body }) => {
    await runner.terminalInput({ params: { terminalId: params.id }, body });
    return undefined;
  },
});
