import 'server-only';
import { projectEnvVars } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { decryptSecret } from '@/server/security/crypto';

/**
 * Environment of a Claude session = the project's variables (decrypted here, sent only to the
 * runner, never to the browser) + the MCP env of `buildSessionMcpConfig`.
 *
 * The runner refuses a session env that contains a protected name (its `rejectedEnvNames`:
 * Nuera's own secrets, Anthropic credentials and billing switches, GitHub/Git plumbing, PATH…):
 * those names are left out here instead of failing the launch. The list mirrors
 * `apps/runner/src/safety/env.ts` (see the lot's followups: move it to @nuera/shared).
 */

const DENY_EXACT = new Set([
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
const DENY_PREFIXES = ['VAPID_', 'GITHUB_', 'GH_', 'GIT_', 'AWS_', 'NUERA_', 'NPM_', 'PNPM_', 'COOLIFY_', 'FIGMA_'];
const PROTECTED = new Set([
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
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_VALUE_LENGTH = 8192;

/** Whether the runner accepts this name in a session env (`SessionEnvSchema` + its deny-list). */
export function isSessionEnvNameAllowed(name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  const upper = name.toUpperCase();
  if (DENY_EXACT.has(upper) || PROTECTED.has(upper)) return false;
  return !DENY_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export interface SessionEnvResult {
  env: Record<string, string>;
  /** Names left out (protected, unreadable or too long) — never their values. */
  skipped: string[];
}

/** Merges env maps (later ones win) and drops what the runner would refuse. */
export function buildSessionEnv(...sources: Array<Record<string, string>>): SessionEnvResult {
  const env: Record<string, string> = {};
  const skipped: string[] = [];
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      if (!isSessionEnvNameAllowed(name) || value.length > MAX_VALUE_LENGTH) {
        if (!skipped.includes(name)) skipped.push(name);
        continue;
      }
      env[name] = value;
    }
  }
  return { env, skipped };
}

/** The project's variables, decrypted (server only). An unreadable value is skipped, never guessed. */
export async function readProjectEnv(projectId: string): Promise<SessionEnvResult> {
  const rows = await db
    .select({ key: projectEnvVars.key, valueEncrypted: projectEnvVars.valueEncrypted })
    .from(projectEnvVars)
    .where(eq(projectEnvVars.projectId, projectId));
  const env: Record<string, string> = {};
  const skipped: string[] = [];
  for (const row of rows) {
    try {
      env[row.key] = decryptSecret(row.valueEncrypted);
    } catch {
      skipped.push(row.key);
    }
  }
  return { env, skipped };
}
