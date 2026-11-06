import { z } from 'zod';
import { AppError } from '@/server/errors';
import { checkGithubSource, handleInstallationSetup, readStateCookie, stateCookie, verifyGithubState } from '@/server/github';
import { integrationsUrl, redirectResponse } from '@/server/github/redirects';
import { apiRoute } from '@/server/http';
import { requireContext } from '@/server/tenancy/context';

/**
 * GET /api/integrations/github/setup?installation_id&setup_action[&state] — GitHub's `setup_url`
 * (the same for every app) after an installation or an update of its repositories. The source is
 * the one of the state (signed for this account and its space), otherwise the source of the space
 * whose app JWT sees this installation; the installation is verified with that app's JWT. A new
 * account is only trusted with a valid state minted by Nuera Dev for this source.
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
    const ctx = await requireContext();
    let stateValid = false;
    let sourceId: string | null = null;
    if (query.state) {
      try {
        const payload = verifyGithubState({
          state: query.state,
          purpose: 'install',
          userId: ctx.user.id,
          cookieNonce: readStateCookie(request.headers.get('cookie'), ctx.user.id),
        });
        if (!payload.spaceId || payload.spaceId === ctx.space.id) {
          stateValid = true;
          sourceId = payload.sourceId;
        }
      } catch {
        stateValid = false;
      }
    }
    const clear = stateCookie(null, ctx.user.id);
    try {
      const result = await handleInstallationSetup({
        installationId: query.installation_id ?? null,
        setupAction: query.setup_action ?? null,
        userId: ctx.user.id,
        spaceId: ctx.space.id,
        sourceId,
        stateValid,
      });
      if ((result.outcome === 'installed' || result.outcome === 'updated') && result.sourceId) {
        await checkGithubSource({ spaceId: ctx.space.id, sourceId: result.sourceId, trigger: 'setup' }).catch(() => undefined);
      }
      const outcome = result.outcome === 'unknown_installation' ? 'installation_unknown' : result.outcome;
      return redirectResponse(
        integrationsUrl(outcome, {
          ...(result.account ? { compte: result.account } : {}),
          ...(result.sourceId ? { source: result.sourceId } : {}),
        }),
        [clear],
      );
    } catch (error) {
      const outcome = error instanceof AppError && error.code === 'CONFLICT' ? 'not_connected' : 'installation_failed';
      return redirectResponse(integrationsUrl(outcome), [clear]);
    }
  },
});
