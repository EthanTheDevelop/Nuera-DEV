import 'server-only';
import { McpConfigSchema, type McpConfig } from '@nuera/shared/runner';
import { projectMcpServers, mcpServers, projects } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getStoredCoolify } from '@/server/coolify/store';
import { getGithubMode } from '@/server/github/access';
import type { GithubMode } from '@/server/github/types';
import { coolifyTokenRefusal, GITHUB_MCP_APP_REQUIRED } from './headers';
import { presetOf } from './presets';
import { credentialSourceOf, denyRulesOf, staticHeadersOf, type McpServerRow } from './registry';

/**
 * Per-session MCP configuration (research §5.7): only the servers enabled for THIS project, given
 * to `claude --mcp-config <file> --strict-mcp-config`. No secret inside — authenticated servers use
 * `headersHelper: 'nuera'`, which the runner replaces by its own helper (bin/nuera-mcp-headers.mjs);
 * the helper asks the web (POST /api/internal/mcp-headers) for the headers of the running session.
 */

export interface SessionMcpConfig {
  /** `{ mcpServers: { … } }` for `--mcp-config` (validated against the runner contract). */
  mcpConfig: McpConfig;
  /** `permissions.deny` rules for the session settings (Figma write tools, Coolify mutating tools…). */
  denyRules: string[];
  /** Non-secret environment additions for the session. */
  env: Record<string, string>;
  /** Servers enabled for the project but left out, with the reason (shown in the Workspace). */
  skipped: Array<{ name: string; reason: string }>;
}

/** Environment given to every Nuera session: claude.ai connectors off (defence in depth with --strict-mcp-config). */
export const SESSION_MCP_ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } as const;

type ServerEntry = McpConfig['mcpServers'][string];

async function entryFor(
  row: McpServerRow,
  context: { coolifyBaseUrl: string | null; coolifyRefusal: string | null; githubMode: GithubMode },
): Promise<{ entry: ServerEntry } | { skip: string }> {
  const preset = presetOf(row.name);
  const credential = credentialSourceOf(row);
  if (row.transport === 'stdio') {
    if (!row.command) return { skip: 'Commande absente.' };
    return { entry: { type: 'stdio', command: row.command, args: row.args } };
  }
  let url = row.url;
  if (preset?.id === 'coolify') {
    if (!context.coolifyBaseUrl) return { skip: "Coolify n'est pas connecté." };
    // A token whose abilities are unverified (or include write) never reaches Claude (P4).
    if (context.coolifyRefusal) return { skip: context.coolifyRefusal };
    url = `${context.coolifyBaseUrl}/mcp`;
  }
  if (credential === 'github_installation' && context.githubMode !== 'app') {
    // Never the fallback PAT: it can be neither read-only nor limited to the session's repository.
    return { skip: context.githubMode === 'fallback_token' ? GITHUB_MCP_APP_REQUIRED : "GitHub n'est pas connecté." };
  }
  if (!url) return { skip: 'Adresse absente.' };
  // Non-secret headers: `mcp_servers.config.headers` + the preset's (which win).
  const staticHeaders = staticHeadersOf(row);
  const headers = Object.keys(staticHeaders).length ? staticHeaders : null;
  const needsHelper = credential === 'github_installation' || credential === 'coolify_token' || credential === 'stored_headers';
  return {
    entry: {
      type: row.transport === 'sse' ? 'sse' : 'http',
      url,
      ...(headers ? { headers: { ...headers } } : {}),
      ...(needsHelper ? { headersHelper: 'nuera' as const } : {}),
    },
  };
}

export async function buildSessionMcpConfig(projectId: string): Promise<SessionMcpConfig> {
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new AppError('NOT_FOUND', 'Projet introuvable.');
  const rows = await db
    .select({ server: mcpServers })
    .from(projectMcpServers)
    .innerJoin(mcpServers, eq(mcpServers.id, projectMcpServers.mcpServerId))
    .where(and(eq(projectMcpServers.projectId, projectId), eq(projectMcpServers.enabled, true), eq(mcpServers.isEnabled, true)));

  const coolify = await getStoredCoolify();
  const context = {
    coolifyBaseUrl: coolify?.config.baseUrl ?? null,
    coolifyRefusal: coolify ? coolifyTokenRefusal(coolify.config) : null,
    githubMode: await getGithubMode(),
  };
  const servers: Record<string, ServerEntry> = {};
  const deny = new Set<string>();
  const skipped: SessionMcpConfig['skipped'] = [];
  for (const { server } of rows.sort((a, b) => a.server.name.localeCompare(b.server.name))) {
    const result = await entryFor(server, context);
    if ('skip' in result) {
      skipped.push({ name: server.name, reason: result.skip });
      continue;
    }
    servers[server.name] = result.entry;
    for (const rule of denyRulesOf(server)) deny.add(rule);
  }
  const mcpConfig = McpConfigSchema.parse({ mcpServers: servers });
  return { mcpConfig, denyRules: [...deny], env: { ...SESSION_MCP_ENV }, skipped };
}
