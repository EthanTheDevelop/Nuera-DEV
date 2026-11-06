import 'server-only';
import { projectMcpServers, projects, sessions } from '@nuera/db/schema';
import type { SessionStatus } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getStoredCoolify, readCoolifyToken, type CoolifyConfig } from '@/server/coolify/store';
import { getProjectCredential, getRepoCredential } from '@/server/github/access';
import { countGithubSources } from '@/server/github/store';
import { presetOf } from './presets';
import { credentialSourceOf, getMcpServerRow, readServerSecrets, type McpServerRow } from './registry';

/**
 * Headers for one MCP server of one running session (POST /api/internal/mcp-headers, called by the
 * runner on behalf of bin/nuera-mcp-headers.mjs). Claude Code runs the helper at each connection and
 * after a 401/403, so a GitHub token expiring after one hour is renewed transparently.
 *
 * Everything comes from the space of the session's project (MULTICOMPTE §7): its registry entry, its
 * Coolify token, the GitHub source of the project. A session of another server answers like an
 * unknown one. When the helper reports the URL Claude Code is about to call, it must be the URL of
 * that server (pinned): a credential is never handed out for another address.
 */

/** Statuses in which a Claude process may legitimately ask for credentials. */
export const LIVE_SESSION_STATUSES: readonly SessionStatus[] = ['new', 'running', 'waiting_permission', 'waiting_input'];

/** Read-only scope of the GitHub MCP token (research §6.3). */
export const GITHUB_MCP_PERMISSIONS = {
  metadata: 'read',
  contents: 'read',
  issues: 'read',
  pull_requests: 'read',
} as const;

export interface SessionMcpHeaders {
  headers: Record<string, string>;
  /** When the credential stops being valid, when known. */
  expiresAt: string | null;
}

/**
 * The GitHub MCP server only ever gets a read-only installation token limited to the session's
 * repository. The fallback PAT (GITHUB_FALLBACK_TOKEN) can neither be limited to one repository nor
 * made read-only, so it is never handed to Claude.
 */
export const GITHUB_MCP_APP_REQUIRED =
  "Le serveur MCP GitHub n'utilise que l'application GitHub de Nuera Dev : le jeton de secours n'est jamais confié à Claude.";

export const UNEXPECTED_MCP_URL = 'Adresse du serveur MCP inattendue : aucun accès n\'est délivré.';

/**
 * Why the stored Coolify token must not reach Claude (P4 « Production hors de portée »), or null.
 * Its abilities must have been read from the tools the Coolify MCP server lists for it (at
 * reconnection, or by a later successful diagnostic): a token whose abilities could not be checked
 * (MCP unavailable at reconnection) stays out of Claude's reach, and so does one that can write.
 */
export function coolifyTokenRefusal(config: Pick<CoolifyConfig, 'abilities' | 'abilitiesSource'>): string | null {
  if (config.abilities.includes('write')) {
    return "Ce jeton Coolify peut modifier Coolify (droit write) : il n'est pas confié à Claude. Reconnectez Coolify avec un jeton limité à read et read:sensitive.";
  }
  if (config.abilitiesSource !== 'mcp_tools') {
    return 'Droits du jeton Coolify non vérifiés : testez la connexion du serveur MCP Coolify.';
  }
  return null;
}

/** `https://host/path/` → `https://host/path` (comparison of the pinned URL). */
export function normalizeMcpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = '';
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return null;
  }
}

/** URL a session is configured to call for this server (session-config.ts builds the same). */
export function expectedMcpUrl(row: Pick<McpServerRow, 'name' | 'url'>, coolifyBaseUrl: string | null): string | null {
  return presetOf(row.name)?.id === 'coolify' ? (coolifyBaseUrl ? `${coolifyBaseUrl}/mcp` : null) : row.url;
}

export async function resolveSessionMcpHeaders(input: {
  sessionId: string;
  serverName: string;
  /** Server (runner) asking: the session must be one of its own. */
  environmentId: string;
  /** URL Claude Code is about to call (`CLAUDE_CODE_MCP_SERVER_URL`), when the helper knows it. */
  serverUrl?: string | null;
  /** Project the runner believes the session belongs to (consistency check). */
  projectId?: string | null;
}): Promise<SessionMcpHeaders> {
  const [session] = await db
    .select({
      id: sessions.id,
      status: sessions.status,
      projectId: sessions.projectId,
      environmentId: sessions.environmentId,
      spaceId: projects.spaceId,
      githubSourceId: projects.githubSourceId,
      githubFullName: projects.githubFullName,
    })
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(eq(sessions.id, input.sessionId))
    .limit(1);
  if (!session || session.environmentId !== input.environmentId || (input.projectId && input.projectId !== session.projectId)) {
    throw new AppError('NOT_FOUND', 'Session inconnue.');
  }
  if (!LIVE_SESSION_STATUSES.includes(session.status)) {
    throw new AppError('FORBIDDEN', "Cette session n'est pas en cours : aucun accès n'est délivré.");
  }
  const server = await getMcpServerRow({ spaceId: session.spaceId, idOrName: input.serverName });
  if (!server || !server.isEnabled) throw new AppError('FORBIDDEN', 'Serveur MCP désactivé.');
  const [activation] = await db
    .select({ enabled: projectMcpServers.enabled })
    .from(projectMcpServers)
    .where(and(eq(projectMcpServers.projectId, session.projectId), eq(projectMcpServers.mcpServerId, server.id)))
    .limit(1);
  if (!activation?.enabled) {
    throw new AppError('FORBIDDEN', "Ce serveur MCP n'est pas activé pour le projet de la session.");
  }
  const coolify = credentialSourceOf(server) === 'coolify_token' || presetOf(server.name)?.id === 'coolify' ? await getStoredCoolify(session.spaceId) : null;
  if (input.serverUrl) {
    const expected = normalizeMcpUrl(expectedMcpUrl(server, coolify?.config.baseUrl ?? null));
    if (!expected || normalizeMcpUrl(input.serverUrl) !== expected) throw new AppError('FORBIDDEN', UNEXPECTED_MCP_URL);
  }

  switch (credentialSourceOf(server)) {
    case 'github_installation': {
      // Never the fallback PAT: GitHub of the project's own source only.
      if ((await countGithubSources(session.spaceId)) === 0) throw new AppError('FORBIDDEN', GITHUB_MCP_APP_REQUIRED);
      const credential = await getProjectCredential(
        { id: session.projectId, spaceId: session.spaceId, githubSourceId: session.githubSourceId, githubFullName: session.githubFullName },
        GITHUB_MCP_PERMISSIONS,
      );
      if (credential.mode !== 'app') throw new AppError('FORBIDDEN', GITHUB_MCP_APP_REQUIRED);
      return { headers: { Authorization: `Bearer ${credential.token}` }, expiresAt: credential.expiresAt };
    }
    case 'coolify_token': {
      if (!coolify) throw new AppError('CONFLICT', "Coolify n'est pas connecté.");
      const refusal = coolifyTokenRefusal(coolify.config);
      if (refusal) throw new AppError('FORBIDDEN', refusal);
      return { headers: { Authorization: `Bearer ${readCoolifyToken(coolify.row)}` }, expiresAt: coolify.config.declaredExpiresAt };
    }
    case 'stored_headers': {
      const secrets = readServerSecrets(server);
      return { headers: { ...(secrets.headers ?? {}) }, expiresAt: server.expiresAt?.toISOString() ?? null };
    }
    default:
      // OAuth grants live in Claude Code; servers without auth need nothing.
      return { headers: {}, expiresAt: null };
  }
}

/**
 * Same credential, outside any session, for the HTTP diagnostics of a server of the space (never
 * returned to a client). The GitHub probe token is scoped to a repository of the space where the
 * server is enabled.
 */
export async function resolveDiagnosticHeaders(server: McpServerRow): Promise<{ headers: Record<string, string>; missing: string | null }> {
  switch (credentialSourceOf(server)) {
    case 'github_installation': {
      if ((await countGithubSources(server.spaceId)) === 0) {
        const { getGithubMode } = await import('@/server/github/access');
        const mode = await getGithubMode(server.spaceId);
        return { headers: {}, missing: mode === 'fallback_token' ? GITHUB_MCP_APP_REQUIRED : "GitHub n'est pas connecté." };
      }
      // Scope the probe token to a repository of the space where the server is enabled, when there is one.
      const [project] = await db
        .select({ id: projects.id, githubFullName: projects.githubFullName, githubSourceId: projects.githubSourceId })
        .from(projectMcpServers)
        .innerJoin(projects, eq(projects.id, projectMcpServers.projectId))
        .where(and(eq(projectMcpServers.mcpServerId, server.id), eq(projectMcpServers.enabled, true), eq(projects.spaceId, server.spaceId)))
        .limit(1);
      if (!project) return { headers: {}, missing: 'Activez ce serveur pour un projet pour le vérifier.' };
      try {
        const credential = project.githubSourceId
          ? await getRepoCredential({ spaceId: server.spaceId, sourceId: project.githubSourceId, fullName: project.githubFullName }, GITHUB_MCP_PERMISSIONS)
          : await getRepoCredential({ spaceId: server.spaceId, fullName: project.githubFullName }, GITHUB_MCP_PERMISSIONS);
        if (credential.mode !== 'app') return { headers: {}, missing: GITHUB_MCP_APP_REQUIRED };
        return { headers: { Authorization: `Bearer ${credential.token}` }, missing: null };
      } catch (error) {
        return { headers: {}, missing: error instanceof AppError ? error.message : "GitHub n'a pas délivré de jeton." };
      }
    }
    case 'coolify_token': {
      const stored = await getStoredCoolify(server.spaceId);
      if (!stored) return { headers: {}, missing: "Coolify n'est pas connecté." };
      try {
        return { headers: { Authorization: `Bearer ${readCoolifyToken(stored.row)}` }, missing: null };
      } catch (error) {
        return { headers: {}, missing: error instanceof AppError ? error.message : 'Le jeton Coolify ne peut pas être déchiffré.' };
      }
    }
    case 'stored_headers':
      return { headers: { ...(readServerSecrets(server).headers ?? {}) }, missing: null };
    default:
      return { headers: {}, missing: null };
  }
}
