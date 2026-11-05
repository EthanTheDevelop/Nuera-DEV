import 'server-only';
import { projectMcpServers, projects, sessions } from '@nuera/db/schema';
import type { SessionStatus } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getCoolifyCredential } from '@/server/coolify';
import { getStoredCoolify, type CoolifyConfig } from '@/server/coolify/store';
import { getGithubMode, getRepoCredential } from '@/server/github/access';
import { credentialSourceOf, getMcpServerRow, readServerSecrets } from './registry';

/**
 * Headers for one MCP server of one running session (POST /api/internal/mcp-headers, called by the
 * runner on behalf of bin/nuera-mcp-headers.mjs). Claude Code runs the helper at each connection and
 * after a 401/403, so a GitHub token expiring after one hour is renewed transparently.
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

export async function resolveSessionMcpHeaders(input: { sessionId: string; serverName: string }): Promise<SessionMcpHeaders> {
  const [session] = await db
    .select({ id: sessions.id, status: sessions.status, projectId: sessions.projectId })
    .from(sessions)
    .where(eq(sessions.id, input.sessionId))
    .limit(1);
  if (!session) throw new AppError('NOT_FOUND', 'Session inconnue.');
  if (!LIVE_SESSION_STATUSES.includes(session.status)) {
    throw new AppError('FORBIDDEN', "Cette session n'est pas en cours : aucun accès n'est délivré.");
  }
  const server = await getMcpServerRow(input.serverName);
  if (!server || !server.isEnabled) throw new AppError('FORBIDDEN', 'Serveur MCP désactivé.');
  const [activation] = await db
    .select({ enabled: projectMcpServers.enabled })
    .from(projectMcpServers)
    .where(and(eq(projectMcpServers.projectId, session.projectId), eq(projectMcpServers.mcpServerId, server.id)))
    .limit(1);
  if (!activation?.enabled) {
    throw new AppError('FORBIDDEN', "Ce serveur MCP n'est pas activé pour le projet de la session.");
  }

  switch (credentialSourceOf(server)) {
    case 'github_installation': {
      if ((await getGithubMode()) !== 'app') throw new AppError('FORBIDDEN', GITHUB_MCP_APP_REQUIRED);
      const [project] = await db
        .select({ githubFullName: projects.githubFullName })
        .from(projects)
        .where(eq(projects.id, session.projectId))
        .limit(1);
      if (!project) throw new AppError('NOT_FOUND', 'Projet introuvable.');
      const credential = await getRepoCredential(project.githubFullName, GITHUB_MCP_PERMISSIONS);
      return { headers: { Authorization: `Bearer ${credential.token}` }, expiresAt: credential.expiresAt };
    }
    case 'coolify_token': {
      const stored = await getStoredCoolify();
      if (!stored) throw new AppError('CONFLICT', "Coolify n'est pas connecté.");
      const refusal = coolifyTokenRefusal(stored.config);
      if (refusal) throw new AppError('FORBIDDEN', refusal);
      const credential = await getCoolifyCredential();
      if (!credential) throw new AppError('CONFLICT', "Coolify n'est pas connecté.");
      return { headers: { Authorization: `Bearer ${credential.token}` }, expiresAt: stored.config.declaredExpiresAt };
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

/** Same credential, outside any session, for the HTTP diagnostics (never returned to a client). */
export async function resolveDiagnosticHeaders(serverName: string): Promise<{ headers: Record<string, string>; missing: string | null }> {
  const server = await getMcpServerRow(serverName);
  if (!server) throw new AppError('NOT_FOUND', 'Serveur MCP introuvable.');
  switch (credentialSourceOf(server)) {
    case 'github_installation': {
      const mode = await getGithubMode();
      if (mode !== 'app') {
        return { headers: {}, missing: mode === 'fallback_token' ? GITHUB_MCP_APP_REQUIRED : "GitHub n'est pas connecté." };
      }
      // Scope the probe token to a repository where the server is enabled, when there is one.
      const [project] = await db
        .select({ githubFullName: projects.githubFullName })
        .from(projectMcpServers)
        .innerJoin(projects, eq(projects.id, projectMcpServers.projectId))
        .where(and(eq(projectMcpServers.mcpServerId, server.id), eq(projectMcpServers.enabled, true)))
        .limit(1);
      if (!project) return { headers: {}, missing: 'Activez ce serveur pour un projet pour le vérifier.' };
      try {
        const credential = await getRepoCredential(project.githubFullName, GITHUB_MCP_PERMISSIONS);
        return { headers: { Authorization: `Bearer ${credential.token}` }, missing: null };
      } catch (error) {
        return { headers: {}, missing: error instanceof AppError ? error.message : "GitHub n'a pas délivré de jeton." };
      }
    }
    case 'coolify_token': {
      const credential = await getCoolifyCredential();
      return credential ? { headers: { Authorization: `Bearer ${credential.token}` }, missing: null } : { headers: {}, missing: "Coolify n'est pas connecté." };
    }
    case 'stored_headers':
      return { headers: { ...(readServerSecrets(server).headers ?? {}) }, missing: null };
    default:
      return { headers: {}, missing: null };
  }
}
