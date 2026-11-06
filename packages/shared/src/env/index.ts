/**
 * Environment variable names Nuera Dev never hands to a child process, shared by the runner
 * (`apps/runner/src/safety/env.ts`, which enforces them) and the web (`server/sessions/env.ts`
 * leaves them out of a session env, `server/projects/env.ts` refuses them as project variables),
 * so both sides always agree.
 *
 *   isDeniedEnvName('GITHUB_TOKEN')            // true  — never inherited, never in a session env
 *   isRejectedSessionEnvName('PATH')           // true  — a session env may not set it
 *   isDeniedProjectEnvName('DATABASE_URL')     // false — a project may define its own
 *
 * The lists are the same for the runner of every server. What the runner must set itself
 * (GIT_AUTHOR_* / GIT_COMMITTER_* from `gitIdentity`, CLAUDE_CONFIG_DIR from NUERA_CLAUDE_CONFIG_DIR,
 * NUERA_HOOK_*) is injected as trusted values, never accepted from a session env.
 */

/** Never passed to a child, whatever the allow-list says (exact names, compared in upper case too). */
export const DENIED_ENV_NAMES: ReadonlySet<string> = new Set([
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
  'RUNNER_DATABASE_URL',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'APP_ENCRYPTION_KEY',
  'APP_ENCRYPTION_PREVIOUS_KEYS',
  'SETUP_TOKEN',
  'NODE_OPTIONS',
  'NUERA_HOOK_TOKEN',
  'NUERA_HOOK_TOKEN_FILE',
  'NUERA_HOOK_URL',
  'NUERA_SESSION_ID',
  'NUERA_PG_PASSWORD',
]);

/** Prefixes (upper case) of denied names: Nuera's own, GitHub/Git plumbing, cloud and tool credentials. */
export const DENIED_ENV_PREFIXES: readonly string[] = ['VAPID_', 'GITHUB_', 'GH_', 'GIT_', 'AWS_', 'NUERA_', 'NPM_', 'PNPM_', 'COOLIFY_', 'FIGMA_'];

/** Names a session env may not set on top of the deny-list (the runner sets them itself, or they inject code). */
export const PROTECTED_SESSION_ENV_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'SHELL',
  'COMSPEC',
  'SYSTEMROOT',
  'CLAUDE_CONFIG_DIR',
  'ENABLE_CLAUDEAI_MCP_SERVERS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
]);

/**
 * Names refused in variables configured *for a project* (given to its own commands): only what
 * would change Claude's billing/credentials, inject code in every process, or impersonate the
 * runner. A project may legitimately define DATABASE_URL, GITHUB_TOKEN…
 */
export const PROTECTED_PROJECT_ENV_NAMES: ReadonlySet<string> = new Set([
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
  'HOME',
  'USERPROFILE',
]);

/** Never inherited by a child, never accepted in a session env. */
export function isDeniedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (DENIED_ENV_NAMES.has(name) || DENIED_ENV_NAMES.has(upper)) return true;
  return DENIED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Refused in a session env (`SessionLaunchOptions.env`): denied or protected. */
export function isRejectedSessionEnvName(name: string): boolean {
  return isDeniedEnvName(name) || PROTECTED_SESSION_ENV_NAMES.has(name.toUpperCase());
}

/** Refused as a project variable (D04 « Variables d'environnement », project commands). */
export function isDeniedProjectEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return PROTECTED_PROJECT_ENV_NAMES.has(upper) || upper.startsWith('NUERA_') || upper.startsWith('GIT_CONFIG');
}
