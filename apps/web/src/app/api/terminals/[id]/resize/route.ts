import { TerminalResizeRequestSchema } from '@nuera/shared/runner';
import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { runner } from '@/server/runner/client';

/** POST /api/terminals/[id]/resize — `{ cols, rows, clientId? }`; the last client that resizes wins. */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }),
  body: TerminalResizeRequestSchema,
  handler: async ({ params, body }) => {
    await runner.terminalResize({ params: { terminalId: params.id }, body });
    return undefined;
  },
});
