import 'server-only';
import { environments } from '@nuera/db/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/server/db';
import { invalidateRunnerEndpoint } from '@/server/runner/config';
import { audit } from '@/server/security/audit';

/**
 * Promotion of a rotated runner token (docs/MULTICOMPTE.md §4): « Renouveler le jeton » stores the
 * new token in `next_token_*` (both tokens are accepted meanwhile); the first successful call made
 * with the new token — the runner restarted with it — promotes it to `token_*`, and the old token
 * stops working (web callbacks and calls alike).
 *
 * Called by the administration's « Vérifier », and meant for the two places that see the new token
 * work: `resolveRunnerCaller` (a callback authenticated by `next_token_hash`) and `callRunner`
 * (an answer obtained with the endpoint's `fallbackToken`). Idempotent; never throws.
 */
export async function promoteRunnerToken(environmentId: string, presentedHash: string): Promise<boolean> {
  try {
    const [promoted] = await db
      .update(environments)
      .set({
        tokenEncrypted: sql`${environments.nextTokenEncrypted}`,
        tokenHash: sql`${environments.nextTokenHash}`,
        nextTokenEncrypted: null,
        nextTokenHash: null,
        tokenRotatedAt: new Date(),
      })
      .where(
        and(
          eq(environments.id, environmentId),
          eq(environments.configSource, 'db'),
          isNotNull(environments.nextTokenHash),
          eq(environments.nextTokenHash, presentedHash),
        ),
      )
      .returning({ id: environments.id, name: environments.name, spaceId: environments.spaceId });
    if (!promoted) return false;
    invalidateRunnerEndpoint(environmentId);
    await audit({
      action: 'environment.token_promoted',
      summary: `nouveau jeton du serveur « ${promoted.name} » en service : l'ancien est refusé`,
      actorKind: 'system',
      targetType: 'environment',
      targetId: environmentId,
      environmentId,
      ip: null,
      userAgent: null,
    });
    return true;
  } catch (error) {
    console.error('[serveurs] promotion du jeton impossible', error instanceof Error ? error.message : error);
    return false;
  }
}
