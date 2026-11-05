import { z } from 'zod';
import { getProjectCoolifyApplications, listCoolifyApplications, toPublicApplication } from '@/server/coolify';
import { apiRoute } from '@/server/http';

/**
 * GET /api/integrations/coolify/applications[?projectId=] — read-only view of the Coolify
 * applications visible to the token; with `projectId`, the applications deploying that project's
 * repository (its branch first) and their latest deployments. Browser-safe fields only.
 */

export const dynamic = 'force-dynamic';

const querySchema = z.object({ projectId: z.uuid().optional() });

export const GET = apiRoute({
  query: querySchema,
  rateLimit: { limit: 60, windowMs: 60_000 },
  handler: async ({ query }) => {
    if (query.projectId) return { projectId: query.projectId, applications: await getProjectCoolifyApplications(query.projectId) };
    return { applications: (await listCoolifyApplications()).map(toPublicApplication) };
  },
});
