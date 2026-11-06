import { revokeInvitation } from '@/server/admin';
import { apiRoute } from '@/server/http';
import { idParams } from '../../_params';

/**   DELETE → 204: revokes an invitation whose link was not used (404 « Invitation introuvable. » otherwise). */
export const DELETE = apiRoute({
  auth: 'admin',
  params: idParams,
  handler: async ({ user, params }) => {
    await revokeInvitation(user, params.id);
  },
});
