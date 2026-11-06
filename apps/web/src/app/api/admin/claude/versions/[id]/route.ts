import { getVersionDetail } from '@/server/claude-config';
import { apiRoute } from '@/server/http';
import { idParams } from '../../../_params';

/** GET → { version, previous, text, diff } (diff by line against the previous version of the item) */
export const dynamic = 'force-dynamic';

export const GET = apiRoute({ auth: 'admin', params: idParams, handler: async ({ user, params }) => getVersionDetail(user, params.id) });
