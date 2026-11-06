import 'server-only';
import { projects, sessions } from '@nuera/db/schema';
import type { ClaudeStatus } from '@nuera/shared/runner';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { ClaudeCliView, SeenModel } from '@/features/settings/lib/types';
import { db } from '@/server/db';
import { requireEnvironment, type RequestContext } from '@/server/tenancy/context';
import { ofSpace } from '@/server/tenancy/scope';

/**
 * Claude Code CLI as the runner of the account's server reports it (one Claude login per server) (`claude --version` + `claude auth status --json`,
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

/**
 * `refresh` asks the runner to run the CLI again instead of answering from its short cache. Without a
 * server: AppError CONFLICT reason NO_ENVIRONMENT (no runner call).
 */
export async function getClaudeCli(
  ctx: Pick<RequestContext, 'environment'>,
  options: { refresh?: boolean; timeoutMs?: number } = {},
): Promise<ClaudeCliView> {
  const { runner } = requireEnvironment(ctx);
  const status = await runner.claudeStatus(
    { query: { refresh: options.refresh ?? false } },
    options.timeoutMs ? { timeoutMs: options.timeoutMs } : {},
  );
  return toClaudeCliView(status);
}

const MODEL_ID = /^[A-Za-z0-9._:[\]-]{1,80}$/;

/**
 * Models the CLI itself reported in the status line of past sessions of the account's space
 * (`sessions.cli_status.model`), most recent first — offered in « Modèle par défaut » next to the
 * documented aliases.
 */
export async function listSeenModels(ctx: Pick<RequestContext, 'space'>, limit = 8): Promise<SeenModel[]> {
  const rows = await db
    .select({
      id: sql<string | null>`${sessions.cliStatus}->'model'->>'id'`,
      displayName: sql<string | null>`${sessions.cliStatus}->'model'->>'displayName'`,
    })
    .from(sessions)
    .innerJoin(projects, and(eq(projects.id, sessions.projectId), eq(projects.environmentId, sessions.environmentId)))
    .where(ofSpace(ctx, isNotNull(sql`${sessions.cliStatus}->'model'->>'id'`)))
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
