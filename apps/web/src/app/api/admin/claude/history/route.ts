import { listHistory } from '@/server/claude-config';
import { apiRoute } from '@/server/http';

/** GET ?kind=&itemId=&before=&limit= → { items: VersionView[], nextBefore } (newest first) */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({ auth: 'admin', handler: async ({ user, query }) => listHistory(user, query) });
