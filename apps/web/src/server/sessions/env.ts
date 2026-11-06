import 'server-only';
import { projectEnvVars } from '@nuera/db/schema';
import { isRejectedSessionEnvName } from '@nuera/shared/env';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { decryptSecret, SecretScopes } from '@/server/security/crypto';
import type { ProjectScope } from '@/server/tenancy/scope';

/**
 * Environment of a Claude session = the project's variables (decrypted here, sent only to the
 * runner, never to the browser) + the MCP env of `buildSessionMcpConfig`.
 *
 * The runner refuses a session env that contains a protected name (its `rejectedEnvNames`:
 * Nuera's own secrets, Anthropic credentials and billing switches, GitHub/Git plumbing, PATH…):
 * those names are left out here instead of failing the launch. Same list as the runner
 * (`@nuera/shared/env`).
 */

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_VALUE_LENGTH = 8192;

/** Whether the runner accepts this name in a session env (`SessionEnvSchema` + its deny-list). */
export function isSessionEnvNameAllowed(name: string): boolean {
  return NAME_RE.test(name) && !isRejectedSessionEnvName(name);
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

/**
 * The variables of a project of the space, decrypted (server only). Only reachable with a scope
 * (`scopeOfProject()`, `readScopedProject()`): the project id comes out of a query that checked
 * the space. Each value is bound to its row (`SecretScopes.projectEnvVar`); the legacy format
 * stays readable. An unreadable value is skipped, never guessed.
 */
export async function readProjectEnv(scope: Pick<ProjectScope, 'projectId'>): Promise<SessionEnvResult> {
  const projectId = scope.projectId;
  const rows = await db
    .select({ key: projectEnvVars.key, valueEncrypted: projectEnvVars.valueEncrypted })
    .from(projectEnvVars)
    .where(eq(projectEnvVars.projectId, projectId));
  const env: Record<string, string> = {};
  const skipped: string[] = [];
  for (const row of rows) {
    try {
      env[row.key] = decryptSecret(row.valueEncrypted, SecretScopes.projectEnvVar(projectId, row.key));
    } catch {
      skipped.push(row.key);
    }
  }
  return { env, skipped };
}
