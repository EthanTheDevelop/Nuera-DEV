import { rollbackVersion } from '@/server/claude-config';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../../_params';

/** POST → { kind, itemId, version } — « Revenir à cette version » (recorded as a NEW version) */
export const dynamic = 'force-dynamic';

export const POST = apiRoute({ auth: 'admin', params: idParams, handler: async ({ user, params }) => rollbackVersion(user, params.id) });
