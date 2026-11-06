import { z } from 'zod';
import { createProposal, listMyProposals } from '@/server/claude-config';
import { apiRoute } from '@/server/http';

/**
 *   GET  → { proposals } (the account's own)
 *   POST { kind: 'rule', title, body, targetId?, note? } | { kind: 'skill', name, skillMd, targetId?, note? }
 *        → { proposal } — applied only once an administrator approves it
 */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({ auth: 'user', handler: async ({ user }) => ({ proposals: await listMyProposals(user) }) });

export const POST = apiRoute({
  auth: 'user',
  body: z.unknown(),
  maxBodyBytes: 600 * 1024,
  handler: async ({ user, body }) => ({ proposal: await createProposal(user, body) }),
});
