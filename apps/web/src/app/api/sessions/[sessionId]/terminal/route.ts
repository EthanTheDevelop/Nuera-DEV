import { sessionParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { getSessionTerminal, withWorkspaceErrors } from '@/server/workspace';

/**
 * GET /api/sessions/[sessionId]/terminal — the PTY of the session's CLI (W2 « Terminal brut »), to
 * render with <TerminalView terminalId=… />. → { terminalId (null when no CLI runs), live }
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: sessionParamsSchema,
  handler: ({ params }) => withWorkspaceErrors(() => getSessionTerminal(params.sessionId)),
});
