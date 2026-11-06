import { z } from 'zod';
import { AppError } from '@/server/errors';
import { completeManifestConversion, GITHUB_STATE_COOKIE, readStateCookie, stateCookie, stateCookieName, verifyGithubState, type GithubStatePayload } from '@/server/github';
import { integrationsUrl, outcomeOfError, redirectResponse } from '@/server/github/redirects';
import { apiRoute } from '@/server/http';
import { requireContext } from '@/server/tenancy/context';

/**
 * GET /api/integrations/github/callback?code&state — GitHub's `redirect_url` after the owner
 * confirmed the app. Checks the signed state (this account, its space, the source allocated at
 * step 1), exchanges the code (POST /app-manifests/{code}/conversions), stores the credentials
 * ENCRYPTED in a new source of the space, then sends the owner to the installation page of the app.
 * A return started by another account of the same browser → `?github=wrong_account`.
 */

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  code: z.string().max(200).optional(),
  state: z.string().max(2048).optional(),
});

/** A state cookie of another account is present, and none of this account's: the flow was started by another account. */
function startedByAnotherAccount(cookieHeader: string | null, userId: string): boolean {
  if (!cookieHeader) return false;
  const own = stateCookieName(userId);
  const names = cookieHeader.split(';').map((part) => part.trim().split('=')[0] ?? '');
  return !names.includes(own) && names.some((name) => name.startsWith(`${GITHUB_STATE_COOKIE}_`));
}

export const GET = apiRoute({
  auth: false,
  query: querySchema,
  handler: async ({ request, query }) => {
    const ctx = await requireContext();
    const clear = stateCookie(null, ctx.user.id);
    const cookieHeader = request.headers.get('cookie');
    let payload: GithubStatePayload;
    try {
      payload = verifyGithubState({
        state: query.state,
        purpose: 'manifest',
        userId: ctx.user.id,
        cookieNonce: readStateCookie(cookieHeader, ctx.user.id),
      });
      if (payload.spaceId && payload.spaceId !== ctx.space.id) throw new AppError('FORBIDDEN', 'Espace différent.');
    } catch (error) {
      const outcome = startedByAnotherAccount(cookieHeader, ctx.user.id) ? 'wrong_account' : outcomeOfError(error, 'state_invalid');
      return redirectResponse(integrationsUrl(outcome), [clear]);
    }
    if (!query.code) return redirectResponse(integrationsUrl('conversion_failed'), [clear]);
    try {
      const result = await completeManifestConversion({
        code: query.code,
        userId: ctx.user.id,
        spaceId: ctx.space.id,
        sourceId: payload.sourceId,
        ...(payload.public === undefined ? {} : { public: payload.public }),
      });
      return redirectResponse(result.installUrl, [stateCookie(result.installNonce, ctx.user.id)]);
    } catch (error) {
      // « already registered » and the source limit have their own outcome; anything GitHub refused
      // is a failed conversion (never reported as a state problem).
      const outcome =
        error instanceof AppError && error.reason === 'SOURCE_LIMIT'
          ? 'source_limit'
          : error instanceof AppError && error.code === 'CONFLICT' && error.message.includes('déjà enregistrée')
            ? 'already_connected'
            : 'conversion_failed';
      return redirectResponse(integrationsUrl(outcome), [clear]);
    }
  },
});
