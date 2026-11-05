import { z } from 'zod';
import { requireUser } from '@/server/auth/session';
import { AppError } from '@/server/errors';
import { checkGithub, GITHUB_STATE_COOKIE, handleInstallationSetup, readCookie, stateCookie, verifyGithubState } from '@/server/github';
import { integrationsUrl, redirectResponse } from '@/server/github/redirects';
import { apiRoute } from '@/server/http';

/**
 * GET /api/integrations/github/setup?installation_id&setup_action[&state] — GitHub's `setup_url`
 * after an installation (or an update of its repositories). The installation is verified with the
 * app JWT; a new account is only trusted with a valid state minted by Nuera Dev.
 */

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  installation_id: z.coerce.number().int().positive().optional(),
  setup_action: z.string().max(40).optional(),
  state: z.string().max(2048).optional(),
});

export const GET = apiRoute({
  auth: false,
  query: querySchema,
  handler: async ({ request, query }) => {
    const user = await requireUser();
    let stateValid = false;
    if (query.state) {
      try {
        verifyGithubState({
          state: query.state,
          purpose: 'install',
          userId: user.id,
          cookieNonce: readCookie(request.headers.get('cookie'), GITHUB_STATE_COOKIE),
        });
        stateValid = true;
      } catch {
        stateValid = false;
      }
    }
    const clear = stateCookie(null);
    try {
      const result = await handleInstallationSetup({
        installationId: query.installation_id ?? null,
        setupAction: query.setup_action ?? null,
        userId: user.id,
        stateValid,
      });
      if (result.outcome === 'installed' || result.outcome === 'updated') {
        await checkGithub({ trigger: 'setup' }).catch(() => undefined);
      }
      const outcome = result.outcome === 'unknown_installation' ? 'installation_unknown' : result.outcome;
      return redirectResponse(integrationsUrl(outcome, result.account ? { compte: result.account } : {}), [clear]);
    } catch (error) {
      const outcome = error instanceof AppError && error.code === 'CONFLICT' ? 'not_connected' : 'installation_failed';
      return redirectResponse(integrationsUrl(outcome), [clear]);
    }
  },
});
