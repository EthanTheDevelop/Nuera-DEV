import { listServers, registerServer, registerServerSchema } from '@/server/admin';
import { apiRoute } from '@/server/http';

/**
 *   GET  → { servers: AdminServerView[] } (never a token, never a Claude account identity)
 *   POST { name, url, location? } → RegisteredServer: `token` (RUNNER_TOKEN) and `databaseUrl`
 *        (RUNNER_DATABASE_URL of the restricted role `dbRole`), both shown once
 */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  auth: 'admin',
  handler: async ({ user }) => ({ servers: await listServers(user) }),
});

export const POST = apiRoute({
  auth: 'admin',
  body: registerServerSchema,
  maxBodyBytes: 2048,
  handler: async ({ user, body }) => registerServer(user, body),
});
