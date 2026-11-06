import type { GitIdentity } from '@nuera/shared/runner';

/**
 * Variables injected by the runner itself (trusted values, they bypass the deny-list of free-form
 * env): never taken from a request's `env` map, where `CLAUDE_CONFIG_DIR` and the `GIT_` prefix
 * stay refused (@nuera/shared/env).
 */

/**
 * `CLAUDE_CONFIG_DIR` of every `claude` process of this runner (sessions, `auth status`, login,
 * `mcp …`, status terminals). One server = one Claude config = one Claude account holder.
 * Null (production): the process environment decides (HOME of the container).
 */
export function claudeEnv(configDir: string | null): Record<string, string> {
  return configDir ? { CLAUDE_CONFIG_DIR: configDir } : {};
}

/**
 * Author and committer of the commits made by a process (Claude's own commits in a session, a
 * shell terminal, a project command): the account that starts it. Absent: the Git configuration
 * of the server.
 */
export function gitIdentityEnv(identity: GitIdentity | null | undefined): Record<string, string> {
  if (!identity) return {};
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}
