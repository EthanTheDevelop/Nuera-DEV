import { withdrawProposal } from '@/server/claude-config';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../admin/_params';

/** DELETE → 204 — withdraws one of the account's own pending proposals (404 for any other). */
export const dynamic = 'force-dynamic';

export const DELETE = apiRoute({
  auth: 'user',
  params: idParams,
  handler: async ({ user, params }) => {
    await withdrawProposal(user, params.id);
  },
});
