import { createInvitation, createInvitationSchema, listInvitations } from '@/server/admin';
import { apiRoute } from '@/server/http';

/**
 *   GET  → { invitations: AdminInvitationView[] } (in progress)
 *   POST { email, role?: 'admin' | 'member', environmentId?, validityHours? } → CreatedInvitation
 *        (`url` = /invitation/<jeton>, shown once)
 */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  auth: 'admin',
  handler: async ({ user }) => ({ invitations: await listInvitations(user) }),
});

export const POST = apiRoute({
  auth: 'admin',
  body: createInvitationSchema,
  maxBodyBytes: 2048,
  handler: async ({ user, body }) => createInvitation(user, body),
});
