import 'server-only';
import { githubSources, integrations, mcpServers } from '@nuera/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/server/db';
import { needsReencryption, reencryptSecret, SecretScopes, type SecretScope } from '@/server/security/crypto';
import { listSpacesToCheck, runIntegrationChecks } from './index';
import { CHECK_INTERVAL_MINUTES } from './model';

/**
 * Clock of the integration checks, in the web (MULTICOMPTE §4 and §7; started by
 * src/instrumentation.ts): every 15 minutes, for each space with something to check, the checks of
 * that space under a PostgreSQL advisory lock (`pg_try_advisory_lock`: one web replica per space),
 * skipping the targets checked less than 10 minutes ago (manual checks, setup). No runner callback
 * triggers these checks. `NUERA_WEB_SCHEDULER=off` disables it (tests).
 *
 * At start it also rewrites, bound to their row, the legacy (unbound) ciphertexts of the integration
 * tables (GitHub sources, Coolify, MCP servers): compare-and-swap, never overwriting a newer value.
 */

const INTERVAL_MS = CHECK_INTERVAL_MINUTES * 60_000;
const FIRST_RUN_DELAY_MS = 60_000;
export const SCHEDULE_SKIP_MS = 10 * 60_000;
/** Advisory-lock class of the integration checks (second key: hashtext(space id)). */
const LOCK_CLASS = 0x4e75_4900;

interface SchedulerState {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
}

const holder = globalThis as unknown as { __nueraWebScheduler?: SchedulerState };

export function webSchedulerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = (env.NUERA_WEB_SCHEDULER ?? 'on').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(value);
}

/** Runs the checks of `spaceId` unless another process holds its lock. True when they ran. */
export async function checkSpaceUnderLock(spaceId: string): Promise<boolean> {
  const reserved = await db.$client.reserve();
  try {
    const [row] = await reserved<Array<{ locked: boolean }>>`select pg_try_advisory_lock(${LOCK_CLASS}::int, hashtext(${spaceId})) as locked`;
    if (!row?.locked) return false;
    try {
      await runIntegrationChecks({ spaceId, trigger: 'schedule', skipCheckedWithinMs: SCHEDULE_SKIP_MS });
      return true;
    } finally {
      await reserved`select pg_advisory_unlock(${LOCK_CLASS}::int, hashtext(${spaceId}))`.catch(() => undefined);
    }
  } finally {
    reserved.release();
  }
}

/** One pass over every space (sequential: a slow provider never piles up concurrent runs). */
export async function runSchedulerTick(): Promise<{ spaces: number; checked: number }> {
  const spaces = await listSpacesToCheck();
  let checked = 0;
  for (const spaceId of spaces) {
    try {
      if (await checkSpaceUnderLock(spaceId)) checked += 1;
    } catch (error) {
      console.error('[intégrations] vérification planifiée impossible', spaceId, error instanceof Error ? error.message : error);
    }
  }
  return { spaces: spaces.length, checked };
}

async function rewrite<T extends { id: string; cipher: string | null }>(
  rows: T[],
  scopeOf: (row: T) => SecretScope,
  write: (row: T, next: string) => Promise<unknown>,
): Promise<number> {
  let count = 0;
  for (const row of rows) {
    if (!row.cipher || !needsReencryption(row.cipher)) continue;
    try {
      const next = reencryptSecret(row.cipher, scopeOf(row));
      if (next !== row.cipher) {
        await write(row, next);
        count += 1;
      }
    } catch {
      // Unreadable value: left as is (its check reports it).
    }
  }
  return count;
}

/** Legacy ciphertexts of the integration tables → bound to their row (compare-and-swap). */
export async function reencryptIntegrationSecrets(): Promise<number> {
  const sources = await db.select({ id: githubSources.id, cipher: githubSources.secretsEncrypted }).from(githubSources).where(isNotNull(githubSources.secretsEncrypted));
  const tokens = await db
    .select({ id: integrations.id, spaceId: integrations.spaceId, kind: integrations.kind, cipher: integrations.secretsEncrypted })
    .from(integrations)
    .where(isNotNull(integrations.secretsEncrypted));
  const servers = await db.select({ id: mcpServers.id, cipher: mcpServers.secretsEncrypted }).from(mcpServers).where(isNotNull(mcpServers.secretsEncrypted));
  return (
    (await rewrite(sources, (row) => SecretScopes.githubSource(row.id), (row, next) =>
      db.update(githubSources).set({ secretsEncrypted: next }).where(and(eq(githubSources.id, row.id), eq(githubSources.secretsEncrypted, row.cipher!))),
    )) +
    (await rewrite(tokens, (row) => SecretScopes.integration(row.spaceId, row.kind), (row, next) =>
      db.update(integrations).set({ secretsEncrypted: next }).where(and(eq(integrations.id, row.id), eq(integrations.secretsEncrypted, row.cipher!))),
    )) +
    (await rewrite(servers, (row) => SecretScopes.mcpServer(row.id), (row, next) =>
      db.update(mcpServers).set({ secretsEncrypted: next }).where(and(eq(mcpServers.id, row.id), eq(mcpServers.secretsEncrypted, row.cipher!))),
    ))
  );
}

/** Starts the clock once per process (no-op when disabled or already started). */
export function startWebScheduler(): void {
  if (!webSchedulerEnabled()) return;
  const state = (holder.__nueraWebScheduler ??= { timer: null, running: false });
  if (state.timer) return;
  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      await runSchedulerTick();
    } catch (error) {
      console.error('[intégrations] horloge des vérifications', error instanceof Error ? error.message : error);
    } finally {
      state.running = false;
    }
  };
  state.timer = setInterval(() => void tick(), INTERVAL_MS);
  state.timer.unref?.();
  const first = setTimeout(() => {
    void reencryptIntegrationSecrets()
      .catch((error: unknown) => console.error('[intégrations] rechiffrement des secrets', error instanceof Error ? error.message : error))
      .finally(() => void tick());
  }, FIRST_RUN_DELAY_MS);
  first.unref?.();
}

/** Stops the clock (tests). */
export function stopWebScheduler(): void {
  const state = holder.__nueraWebScheduler;
  if (state?.timer) clearInterval(state.timer);
  if (state) state.timer = null;
}
