import { deleteAccount, getAccount } from '@/server/admin';
import { apiRoute } from '@/server/http';
import { idParams } from '../../_params';

/**
 *   GET    → { account: AdminAccountView } (404 « Compte introuvable. » for an unknown or deleted account)
 *   DELETE → anonymises a DISABLED account (space archived, server retired); never the owner nor oneself
 */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  auth: 'admin',
  params: idParams,
  handler: async ({ user, params }) => ({ account: await getAccount(user, params.id) }),
});

export const DELETE = apiRoute({
  auth: 'admin',
  params: idParams,
  handler: async ({ user, params }) => ({ deleted: await deleteAccount(user, params.id) }),
});
