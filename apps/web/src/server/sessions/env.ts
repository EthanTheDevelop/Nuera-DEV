import 'server-only';
import { projectEnvVars } from '@nuera/db/schema';
import { isRejectedSessionEnvName } from '@nuera/shared/env';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { decryptSecret } from '@/server/security/crypto';

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
