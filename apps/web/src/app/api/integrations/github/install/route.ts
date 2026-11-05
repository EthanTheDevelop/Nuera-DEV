import { requireUser } from '@/server/auth/session';
import { createGithubState, getGithubStatus, installUrl, stateCookie } from '@/server/github';
import { integrationsUrl, redirectResponse } from '@/server/github/redirects';
import { apiRoute } from '@/server/http';

/**
 * GET /api/integrations/github/install — « Installer sur GitHub » / « Réautoriser sur GitHub »:
 * redirects to the installation page of the app with a fresh signed state, so that the setup
 * callback can allow-list the account the owner picks.
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  auth: false,
  handler: async () => {
    const user = await requireUser();
    const status = await getGithubStatus();
    if (status.mode !== 'app' || !status.app) return redirectResponse(integrationsUrl('not_connected'));
    const { state, nonce } = createGithubState({ purpose: 'install', userId: user.id });
    return redirectResponse(installUrl(status.app.slug, state), [stateCookie(nonce)]);
  },
});
