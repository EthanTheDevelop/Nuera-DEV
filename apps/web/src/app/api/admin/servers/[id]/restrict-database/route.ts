import { restrictServerDatabase } from '@/server/admin';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/**   POST → RestrictedDatabaseAccess (`databaseUrl` for RUNNER_DATABASE_URL, shown once). */
export const POST = apiRoute({
  auth: 'admin',
  params: idParams,
  handler: async ({ user, params }) => restrictServerDatabase(user, params.id),
});
