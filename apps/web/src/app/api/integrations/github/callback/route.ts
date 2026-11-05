import { z } from 'zod';
import { requireUser } from '@/server/auth/session';
import { AppError } from '@/server/errors';
import {
  completeManifestConversion,
  GITHUB_STATE_COOKIE,
  readCookie,
  stateCookie,
  verifyGithubState,
  type GithubStatePayload,
} from '@/server/github';
import { integrationsUrl, outcomeOfError, redirectResponse } from '@/server/github/redirects';
import { apiRoute } from '@/server/http';

/**
 * GET /api/integrations/github/callback?code&state — GitHub's `redirect_url` after the owner
 * confirmed the app. Exchanges the code (POST /app-manifests/{code}/conversions), stores the
 * credentials ENCRYPTED, then sends the owner to the installation page of the new app.
 */

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  code: z.string().max(200).optional(),
  state: z.string().max(2048).optional(),
});

export const GET = apiRoute({
  auth: false,
  query: querySchema,
  handler: async ({ request, query }) => {
    const user = await requireUser();
    const clear = stateCookie(null);
    let payload: GithubStatePayload;
    try {
      payload = verifyGithubState({
        state: query.state,
        purpose: 'manifest',
        userId: user.id,
        cookieNonce: readCookie(request.headers.get('cookie'), GITHUB_STATE_COOKIE),
      });
    } catch (error) {
      return redirectResponse(integrationsUrl(outcomeOfError(error, 'state_invalid')), [clear]);
    }
    if (!query.code) return redirectResponse(integrationsUrl('conversion_failed'), [clear]);
    try {
      const result = await completeManifestConversion({
        code: query.code,
        userId: user.id,
        ...(payload.public === undefined ? {} : { public: payload.public }),
      });
      return redirectResponse(result.installUrl, [stateCookie(result.installNonce)]);
    } catch (error) {
      // Only the « already registered » conflict has its own outcome; anything GitHub refused is a
      // failed conversion (never reported as a state problem).
      const outcome =
        error instanceof AppError && error.code === 'CONFLICT' && error.message.includes('déjà')
          ? 'already_connected'
          : 'conversion_failed';
      return redirectResponse(integrationsUrl(outcome), [clear]);
    }
  },
});
