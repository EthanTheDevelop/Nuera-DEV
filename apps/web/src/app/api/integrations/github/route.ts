import { disconnectGithub, getGithubStatus } from '@/server/github';
import { apiRoute } from '@/server/http';

/**
 * GET    /api/integrations/github — status of the GitHub App (D07 tile: accounts, repositories,
 *        permissions, last check, journal). Never contains a secret.
 * DELETE /api/integrations/github — « Déconnecter »: deletes the stored credentials (audited).
 *        The app itself is deleted on github.com by the owner (`appHtmlUrl`).
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  handler: async () => getGithubStatus(),
});

export const DELETE = apiRoute({
  handler: async ({ user }) => disconnectGithub({ actorUserId: user.id }),
});
