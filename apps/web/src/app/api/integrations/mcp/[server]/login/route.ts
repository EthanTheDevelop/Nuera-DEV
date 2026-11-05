import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { startMcpLogin } from '@/server/mcp';

/**
 * POST /api/integrations/mcp/[server]/login — « Reconnecter » an OAuth server (Figma): opens an
 * ephemeral web terminal on VPS-3 running `claude mcp login <name> --no-browser` (output never
 * recorded). The browser then attaches to `streamUrl` and sends keystrokes to
 * /api/terminals/<id>/input. Nuera Dev stores nothing: the grant stays in Claude Code.
 */

export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  params: z.object({ server: z.string().min(1).max(64) }),
  rateLimit: { limit: 10, windowMs: 10 * 60_000 },
  handler: async ({ params: { server }, user }) => {
    const { terminal, streamUrl } = await startMcpLogin(server, { actorUserId: user.id });
    return { terminalId: terminal.id, title: terminal.title, streamUrl, inputUrl: `/api/terminals/${encodeURIComponent(terminal.id)}/input` };
  },
});
