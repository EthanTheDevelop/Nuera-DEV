/**
 * Environment given to every child process (git, PTY shells, Claude, project commands).
 *
 * Allow-list first (only what a shell/CLI needs), then a deny-list that always wins: no secret of
 * Nuera Dev, no Anthropic credential/billing switch, no GitHub token, no inherited git plumbing.
 */

import { isDeniedEnvName, isDeniedProjectEnvName, isRejectedSessionEnvName } from '@nuera/shared/env';

const ALLOW_EXACT = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  // Claude Code: same config dir for every claude process of a runner (one server = one login;
  // NUERA_CLAUDE_CONFIG_DIR overrides it as a trusted value), update policy.
  'CLAUDE_CONFIG_DIR',
  'DISABLE_AUTOUPDATER',
  'DISABLE_UPDATES',
  // Windows essentials
  'SystemRoot',
  'SYSTEMROOT',
  'SystemDrive',
  'windir',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'Path',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'COMPUTERNAME',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PSModulePath',
]);
const ALLOW_PREFIXES = ['LC_', 'XDG_'];

// Deny-lists shared with the web (session env, project variables): @nuera/shared/env.
export { isDeniedEnvName, isDeniedProjectEnvName };

function isAllowedEnvName(name: string): boolean {
  if (ALLOW_EXACT.has(name)) return true;
  return ALLOW_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export interface ChildEnvOptions {
  /**
   * `strict` (default): extra entries follow the same deny-list as inherited ones (session env).
   * `project`: extra entries are the project's own variables ({@link isDeniedProjectEnvName}).
   */
  policy?: 'strict' | 'project';
  source?: NodeJS.ProcessEnv;
}

/**
 * Sanitised copy of `process.env` plus `extra` (validated by the caller: session MCP env,
 * project variables). Extra entries with a refused name are dropped.
 */
export function buildChildEnv(
  extra: Record<string, string | undefined> = {},
  options: ChildEnvOptions = {},
): Record<string, string> {
  const source = options.source ?? process.env;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!isAllowedEnvName(name) || isDeniedEnvName(name)) continue;
    env[name] = value;
  }
  const refused = options.policy === 'project' ? isDeniedProjectEnvName : isDeniedEnvName;
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined || refused(name)) continue;
    env[name] = value;
  }
  return env;
}

/**
 * Same as {@link buildChildEnv} but for variables that the runner itself must inject
 * (NUERA_HOOK_URL, GIT_CONFIG_*…): `trusted` bypasses the deny-list.
 */
export function withTrustedEnv(base: Record<string, string>, trusted: Record<string, string | undefined>): Record<string, string> {
  const env = { ...base };
  for (const [name, value] of Object.entries(trusted)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/** Names the caller may not set through request-provided env maps. */
export function rejectedEnvNames(names: Iterable<string>): string[] {
  return [...names].filter((name) => isRejectedSessionEnvName(name));
}
