import { z } from 'zod';
import { listProposals } from '@/server/claude-config';
import { apiRoute } from '@/server/http';

/** GET ?statut=toutes → { proposals } (pending ones by default) */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  auth: 'admin',
  query: z.object({ statut: z.enum(['en-attente', 'toutes']).default('en-attente') }),
  handler: async ({ user, query }) => ({ proposals: await listProposals(user, query.statut === 'toutes' ? 'all' : 'pending') }),
});
