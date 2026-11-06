import { listAccounts } from '@/server/admin';
import { apiRoute } from '@/server/http';

/**
 * Administration › Comptes (owner and administrators; a member gets 403).
 *   GET → { accounts: AdminAccountView[] } (space, server, second factor, last sign-in, open accesses)
 */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  auth: 'admin',
  handler: async ({ user }) => ({ accounts: await listAccounts(user) }),
});
