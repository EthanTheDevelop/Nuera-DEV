import { z } from 'zod';
import { removeServerAccount } from '@/server/admin';
import { apiRoute } from '@/server/http';

/**
 * DELETE → { server } — the account leaves a shared server (lot P1): refused for its first account
 * and while the account has projects there; its Claude Code folder on the runner is removed
 * (journal `admin.server_account_removed`). Ids are never validated here (unknown = 404).
 */
const params = z.object({ id: z.string().trim().min(1).max(200), userId: z.string().trim().min(1).max(200) });

export const DELETE = apiRoute({
  auth: 'admin',
  params,
  handler: async ({ user, params: { id, userId } }) => ({ server: await removeServerAccount(user, id, userId) }),
});
