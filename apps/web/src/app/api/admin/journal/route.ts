import { getInstanceJournal, journalQuerySchema } from '@/server/admin';
import { apiRoute } from '@/server/http';

/**
 *   GET ?before=&limit=&userId= → instance journal (auth.*, admin.*, environment.*, instance.*,
 *   security.*; never a Git, project, session or terminal event).
 */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  auth: 'admin',
  query: journalQuerySchema,
  handler: async ({ user, query }) => getInstanceJournal(user, query),
});
