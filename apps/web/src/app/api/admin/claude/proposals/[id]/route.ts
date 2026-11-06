import { z } from 'zod';
import { decideProposal } from '@/server/claude-config';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/** POST { decision: 'approve' | 'reject', note? } → { proposal } (approve = applied as a new version) */
export const dynamic = 'force-dynamic';

export const POST = apiRoute({
  auth: 'admin',
  params: idParams,
  body: z.unknown(),
  maxBodyBytes: 16 * 1024,
  handler: async ({ user, params, body }) => ({ proposal: await decideProposal(user, params.id, body) }),
});
