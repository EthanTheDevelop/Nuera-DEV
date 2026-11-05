import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { proxyRunnerStream } from '@/server/runner/client';

/**
 * GET /api/stream/terminals/[id] — bytes of a PTY: `terminal.snapshot` (serialized screen +
 * scrollback, always first, also after every reconnection) then `terminal.data`, `terminal.resize`,
 * `terminal.exit`. Write `snapshot.data` then each `data` chunk into xterm.js as they are.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }),
  handler: ({ request, params }) => proxyRunnerStream(request, `/v1/terminals/${params.id}/stream`),
});
