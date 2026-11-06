import { disconnectGithub, getGithubOverview } from '@/server/github';
import { apiRoute } from '@/server/http';

/**
 * GET    /api/integrations/github — GitHub of the space (D07): the aggregate status (identical to
 *        the source when the space has only one: accounts, repositories, permissions, last check,
 *        journal) plus `sources[]` (one entry per GitHub source). Never contains a secret.
 * DELETE /api/integrations/github — historical « Déconnecter »: the space's only source (409 when
 *        several are connected: /api/integrations/github/sources/[sourceId] says which). Audited.
 *        The app itself is deleted on github.com by the owner (`appHtmlUrl`).
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  handler: async ({ ctx }) => getGithubOverview(ctx.space.id),
});

export const DELETE = apiRoute({
  handler: async ({ ctx, user }) => disconnectGithub({ spaceId: ctx.space.id, actorUserId: user.id }),
});
