import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { startMcpLogin } from '@/server/mcp';

/**
 * POST /api/integrations/mcp/[server]/login — « Reconnecter » an OAuth server (Figma) of the space:
 * opens an ephemeral web terminal on the space's server running `claude mcp login <name>
 * --no-browser` (output never recorded), owned by this account. The browser then attaches to
 * `streamUrl` and sends keystrokes to /api/terminals/<id>/input. Nuera Dev stores nothing: the grant
 * stays in Claude Code. Same gate as the other login terminals: 409 « Aucun serveur ne vous est
 * encore attribué… » without a server, 403 for a member who does not own the space or a suspended
 * server, 404 for an unknown server or one of another space.
 */

export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  params: z.object({ server: z.string().min(1).max(64) }),
  rateLimit: { limit: 10, windowMs: 10 * 60_000 },
  handler: async ({ params: { server }, ctx }) => {
    const { terminal, streamUrl } = await startMcpLogin(ctx, server);
    return { terminalId: terminal.id, title: terminal.title, streamUrl, inputUrl: `/api/terminals/${encodeURIComponent(terminal.id)}/input` };
  },
});
