import 'server-only';
import { environments } from '@nuera/db/schema';
import type { CommonConfigStatus } from '@nuera/shared/runner';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getRunnerForEnvironment, isRunnerUnavailable, runnerUnavailableMessage } from '@/server/runner/client';

/**
 * Announces a change of the common configuration to the runners (`POST /v1/claude/config/sync`): each
 * one fetches the configuration of its server from the web and writes it. Fire-and-forget after a
 * change (debounced: an editor saving several items triggers one round), awaited by « Synchroniser les
 * serveurs » in the administration. A runner that does not answer catches up at its next start or
 * before its next session (the launch options carry the expected hash).
 */

export interface ServerSyncResult {
  environmentId: string;
  name: string;
  ok: boolean;
  status: CommonConfigStatus | null;
  error: string | null;
}

const DEBOUNCE_MS = 400;
const holder = globalThis as unknown as { __nueraCommonConfigTimer?: ReturnType<typeof setTimeout> | null };

/** Every server in service (assigned and active): the ones whose runner holds sessions (it writes the copy of each of its accounts). */
async function serversInService(environmentIds?: string[]): Promise<Array<{ id: string; name: string }>> {
  const conditions = [eq(environments.status, 'active'), isNotNull(environments.spaceId), ...(environmentIds?.length ? [inArray(environments.id, environmentIds)] : [])];
  return db.select({ id: environments.id, name: environments.name }).from(environments).where(and(...conditions));
}

export async function syncServers(reason: 'changed' | 'manual', environmentIds?: string[]): Promise<ServerSyncResult[]> {
  const servers = await serversInService(environmentIds);
  return Promise.all(
    servers.map(async (server): Promise<ServerSyncResult> => {
      try {
        const status = await getRunnerForEnvironment(server.id).claudeConfigSync({ body: { reason } }, { timeoutMs: 45_000 });
        return { environmentId: server.id, name: server.name, ok: status.error === null, status, error: status.error };
      } catch (error) {
        const message = isRunnerUnavailable(error)
          ? runnerUnavailableMessage(server.name)
          : error instanceof AppError && error.status === 404
            ? `Le runner de ${server.name} est trop ancien pour la configuration commune : redéployez-le.`
            : error instanceof AppError
              ? error.message
              : `${server.name} n'a pas pu appliquer la configuration commune.`;
        return { environmentId: server.id, name: server.name, ok: false, status: null, error: message };
      }
    }),
  );
}

/** After a change: every server in service, in the background (never fails the request). */
export function scheduleCommonConfigSync(environmentIds?: string[]): void {
  if (process.env.NUERA_CLAUDE_CONFIG_PUSH === 'off') return;
  if (environmentIds) {
    void syncServers('changed', environmentIds).catch(() => undefined);
    return;
  }
  if (holder.__nueraCommonConfigTimer) clearTimeout(holder.__nueraCommonConfigTimer);
  holder.__nueraCommonConfigTimer = setTimeout(() => {
    holder.__nueraCommonConfigTimer = null;
    void syncServers('changed').catch((error: unknown) => console.warn('[configuration commune] synchronisation des serveurs', error));
  }, DEBOUNCE_MS);
  holder.__nueraCommonConfigTimer.unref?.();
}

/**
 * Status of the copy written on one server for one of its accounts (lot P1: each account has its own
 * Claude config folder; `spaceId` omitted: its first account). Null: runner unreachable or too old.
 */
export async function serverSyncStatus(environmentId: string, spaceId?: string | null): Promise<CommonConfigStatus | null> {
  try {
    return await getRunnerForEnvironment(environmentId).claudeConfigStatus(spaceId ? { query: { spaceId } } : undefined, { timeoutMs: 6_000 });
  } catch {
    return null;
  }
}
