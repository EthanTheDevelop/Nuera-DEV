import { testInstanceMcp } from '@/server/claude-config';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../../_params';

/** POST → { server, ok, tools, message, rules } (initialize + tools/list with the stored credential) */
export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  auth: 'admin',
  params: idParams,
  rateLimit: { limit: 20, windowMs: 60_000 },
  handler: async ({ user, params }) => testInstanceMcp(user, params.id),
});
