import 'server-only';
import { sessions } from '@nuera/db/schema';
import type { ClaudeStatus } from '@nuera/shared/runner';
import { desc, isNotNull, sql } from 'drizzle-orm';
import type { ClaudeCliView, SeenModel } from '@/features/settings/lib/types';
import { db } from '@/server/db';
import { runner } from '@/server/runner/client';

/**
 * Claude Code CLI as the runner reports it (`claude --version` + `claude auth status --json`,
 * whitelisted fields). Nuera Dev never reads credentials: only what the CLI prints.
 */
export function toClaudeCliView(status: ClaudeStatus): ClaudeCliView {
  return {
    checkedAt: status.checkedAt,
    state: status.state,
    installed: status.installed,
    version: status.version,
    loggedIn: status.auth?.loggedIn ?? null,
    authMethod: status.auth?.authMethod ?? null,
    subscriptionType: status.auth?.subscriptionType ?? null,
    loginExpiresAt: status.auth?.loginExpiresAt ?? null,
    error: status.error,
  };
}

/** `refresh` asks the runner to run the CLI again instead of answering from its short cache. */
export async function getClaudeCli(options: { refresh?: boolean; timeoutMs?: number } = {}): Promise<ClaudeCliView> {
  const status = await runner.claudeStatus(
    { query: { refresh: options.refresh ?? false } },
    options.timeoutMs ? { timeoutMs: options.timeoutMs } : {},
  );
  return toClaudeCliView(status);
}

const MODEL_ID = /^[A-Za-z0-9._:[\]-]{1,80}$/;

/**
 * Models the CLI itself reported in the status line of past sessions (`sessions.cli_status.model`),
 * most recent first — offered in « Modèle par défaut » next to the documented aliases.
 */
export async function listSeenModels(limit = 8): Promise<SeenModel[]> {
  const rows = await db
    .select({
      id: sql<string | null>`${sessions.cliStatus}->'model'->>'id'`,
      displayName: sql<string | null>`${sessions.cliStatus}->'model'->>'displayName'`,
    })
    .from(sessions)
    .where(isNotNull(sql`${sessions.cliStatus}->'model'->>'id'`))
    .orderBy(desc(sessions.updatedAt))
    .limit(200);
  const seen = new Map<string, SeenModel>();
  for (const row of rows) {
    if (!row.id || !MODEL_ID.test(row.id) || seen.has(row.id)) continue;
    seen.set(row.id, { id: row.id, displayName: row.displayName?.trim().slice(0, 60) || null });
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}
