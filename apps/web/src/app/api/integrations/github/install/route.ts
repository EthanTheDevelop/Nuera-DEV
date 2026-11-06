import { z } from 'zod';
import { createGithubState, installUrl, listGithubSources, stateCookie } from '@/server/github';
import { integrationsUrl, redirectResponse } from '@/server/github/redirects';
import { apiRoute } from '@/server/http';
import { requireContext } from '@/server/tenancy/context';

/**
 * GET /api/integrations/github/install[?source=<id>] — « Installer sur GitHub » / « Réautoriser sur
 * GitHub » of a source of the space: redirects to the installation page of that app with a fresh
 * signed state (account, space, source), so that the setup callback can allow-list the account the
 * owner picks. Without `source`: the space's only source (historical links); several sources →
 * back to Intégrations (`?github=choose_source`). A source of another space is unknown.
 */

export const dynamic = 'force-dynamic';

const querySchema = z.object({ source: z.string().max(64).optional() });

export const GET = apiRoute({
  auth: false,
  query: querySchema,
  handler: async ({ query }) => {
    const ctx = await requireContext();
    const { sources } = await listGithubSources(ctx.space.id);
    const source = query.source ? sources.find((item) => item.id === query.source) : sources.length === 1 ? sources[0] : undefined;
    if (!source) {
      return redirectResponse(integrationsUrl(!query.source && sources.length > 1 ? 'choose_source' : 'not_connected'));
    }
    const { state, nonce } = createGithubState({ purpose: 'install', userId: ctx.user.id, spaceId: ctx.space.id, sourceId: source.id });
    return redirectResponse(installUrl(source.config.slug, state), [stateCookie(nonce, ctx.user.id)]);
  },
});
