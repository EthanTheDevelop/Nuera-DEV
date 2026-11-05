import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { runner } from '@/server/runner/client';

/**
 * DELETE /api/terminals/[id] — closes a terminal (shell, login, /status). A session terminal is
 * refused (409): stop the session instead. Login terminals drop their scrollback on close.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const DELETE = apiRoute({
  params: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }),
  handler: async ({ params }) => {
    await runner.closeTerminal({ params: { terminalId: params.id } });
    return undefined;
  },
});
