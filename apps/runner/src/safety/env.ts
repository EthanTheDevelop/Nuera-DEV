/**
 * Environment given to every child process (git, PTY shells, Claude, project commands).
 *
 * Allow-list first (only what a shell/CLI needs), then a deny-list that always wins: no secret of
 * Nuera Dev, no Anthropic credential/billing switch, no GitHub token, no inherited git plumbing.
 */

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
  // Claude Code: same config dir everywhere (one supervisor, one login), update policy.
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

/** Never passed to a child, whatever the allow-list says. */
export const DENY_EXACT = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_GROWTHBOOK',
  'RUNNER_TOKEN',
  'RUNNER_URL',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'APP_ENCRYPTION_KEY',
  'SETUP_TOKEN',
  'NODE_OPTIONS',
  'NUERA_HOOK_TOKEN',
  'NUERA_HOOK_TOKEN_FILE',
  'NUERA_HOOK_URL',
  'NUERA_SESSION_ID',
  'NUERA_PG_PASSWORD',
]);
export const DENY_PREFIXES = ['VAPID_', 'GITHUB_', 'GH_', 'GIT_', 'AWS_', 'NUERA_', 'npm_', 'PNPM_', 'COOLIFY_', 'FIGMA_'];

export function isDeniedEnvName(name: string): boolean {
  if (DENY_EXACT.has(name)) return true;
  const upper = name.toUpperCase();
  if (DENY_EXACT.has(upper)) return true;
  return DENY_PREFIXES.some((prefix) => name.startsWith(prefix) || upper.startsWith(prefix.toUpperCase()));
}

function isAllowedEnvName(name: string): boolean {
  if (ALLOW_EXACT.has(name)) return true;
  return ALLOW_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Names refused in variables configured *for a project* (project_env_vars, given to its own
 * commands): only what would change Claude's billing/credentials, inject code in every process,
 * or impersonate the runner. A project may legitimately define DATABASE_URL, GITHUB_TOKEN…
 */
const PROJECT_DENY_EXACT = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CONFIG_DIR',
  'RUNNER_TOKEN',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
]);
export function isDeniedProjectEnvName(name: string): boolean {
  return PROJECT_DENY_EXACT.has(name) || name.toUpperCase().startsWith('NUERA_') || name.toUpperCase().startsWith('GIT_CONFIG');
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
  const protectedNames = new Set(['PATH', 'Path', 'HOME', 'USERPROFILE', 'SHELL', 'ComSpec', 'COMSPEC', 'SystemRoot', 'CLAUDE_CONFIG_DIR', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES']);
  return [...names].filter((name) => isDeniedEnvName(name) || protectedNames.has(name));
}
