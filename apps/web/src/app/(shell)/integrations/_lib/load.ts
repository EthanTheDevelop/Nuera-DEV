import 'server-only';
import { getCoolifySettings } from '@/server/coolify';
import { toAppError } from '@/server/errors';
import { getGithubStatus } from '@/server/github';
import { getIntegrationsOverview } from '@/server/integrations';
import { CHECK_INTERVAL_MINUTES } from '@/server/integrations/model';
import { getMcpServer } from '@/server/mcp';
import type { IntegrationsOverview, Loaded, McpDetailContext, McpServerView } from '@/features/integrations/types';

/**
 * Server loaders of the Intégrations routes (D07 / M07 page, D1 / D2 drawer and full page). They only
 * compose the existing server modules (database reads, no network call, no secret) and turn a failure
 * into the T4 description shown inline by the page.
 */

function failure(error: unknown) {
  const appError = toAppError(error);
  if (appError.code === 'INTERNAL') console.error('[integrations] chargement', error);
  return {
    ok: false as const,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.detail ? { detail: appError.detail } : {}),
      ...(appError.raw ? { raw: appError.raw } : {}),
    },
  };
}

export async function loadOverview(): Promise<Loaded<IntegrationsOverview>> {
  try {
    return { ok: true, data: await getIntegrationsOverview() };
  } catch (error) {
    return failure(error);
  }
}

export type McpDetailLoad = Loaded<{ server: McpServerView; context: McpDetailContext }> | { ok: 'not_found' };

export async function loadMcpDetail(serverId: string): Promise<McpDetailLoad> {
  try {
    const [coolify, github] = await Promise.all([getCoolifySettings(), getGithubStatus()]);
    const server = await getMcpServer(serverId, { coolifyBaseUrl: coolify.baseUrl });
    return {
      ok: true,
      data: {
        server,
        context: {
          coolify,
          github: {
            mode: github.mode,
            status: github.status,
            accounts: github.accounts,
            manageAccessUrl: github.manageAccessUrl,
            installUrl: github.installUrl,
            action: github.action,
            app: github.app,
          },
          checkIntervalMinutes: CHECK_INTERVAL_MINUTES,
        },
      },
    };
  } catch (error) {
    if (toAppError(error).code === 'NOT_FOUND') return { ok: 'not_found' };
    return failure(error);
  }
}

/** Route segment value → server identifier (name or uuid), refused when malformed. */
export function serverIdOf(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  return /^[A-Za-z0-9-]{1,64}$/.test(decoded) ? decoded : null;
}
