import { startManifestResponse } from '@/server/github/flow';
import { apiRoute } from '@/server/http';

/**
 * POST /api/integrations/github/manifest — « Connecter GitHub » (D07): creates a GitHub source of the
 * space (one more, up to the limit). Accepts a form post (`organization`, `public`) or JSON, and
 * answers with a self-submitting page that posts the App manifest (unique name, private unless
 * `public`) to github.com with a signed `state` (valid one hour, bound to this account and browser by
 * an HttpOnly cookie). Same as POST /api/integrations/github/sources.
 */

export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  rateLimit: { limit: 10, windowMs: 10 * 60_000 },
  handler: async ({ request, ctx }) => startManifestResponse(request, ctx),
});
