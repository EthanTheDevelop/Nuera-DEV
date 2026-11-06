import { createDb } from '@nuera/db';
import { integrations, mcpServers } from '@nuera/db/schema';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount } from '@/server/tenancy/test/fixtures';
import { allowLocalFakes, closeTestDb, prepareTestDatabase, resetTables, TEST_SPACE_ID, useTestEncryptionKey } from './test/db';

/*
 * Web clock of the integration checks (instrumentation.ts → scheduler.ts): spaces to check, one web
 * replica per space (advisory lock), recent targets skipped, legacy ciphertexts rewritten bound.
 */

let url: string;

beforeAll(async () => {
  url = await prepareTestDatabase('scheduler');
  useTestEncryptionKey();
  allowLocalFakes();
  delete process.env.GITHUB_FALLBACK_TOKEN;
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTables();
});

async function storeCoolify(spaceId: string, checkedAt: Date) {
  const { coolifyConfigSchema, upsertCoolify } = await import('@/server/coolify/store');
  await upsertCoolify({
    spaceId,
    // Unreachable on purpose (discard port): a check that runs records an error step.
    config: coolifyConfigSchema.parse({ baseUrl: 'http://127.0.0.1:9', connectedAt: '2026-11-01T08:00:00.000Z' }),
    token: '67|abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    status: 'connected',
    checkedAt,
  });
}

describe('web scheduler', () => {
  it('is disabled by NUERA_WEB_SCHEDULER=off', async () => {
    const { webSchedulerEnabled } = await import('./scheduler');
    expect(webSchedulerEnabled({})).toBe(true);
    expect(webSchedulerEnabled({ NUERA_WEB_SCHEDULER: 'off' })).toBe(false);
    expect(webSchedulerEnabled({ NUERA_WEB_SCHEDULER: '0' })).toBe(false);
    expect(webSchedulerEnabled({ NUERA_WEB_SCHEDULER: 'on' })).toBe(true);
  });

  it('lists the spaces with something to check, each once', async () => {
    const b = await createTestAccount({ role: 'member', environment: false });
    await createTestAccount({ role: 'member', environment: false, email: 'empty@example.test' });
    await storeCoolify(b.space.id, new Date());
    const { listSpacesToCheck } = await import('./index');
    const { ensurePresetServers } = await import('@/server/mcp/registry');
    await ensurePresetServers(TEST_SPACE_ID);
    expect(await listSpacesToCheck()).toEqual([TEST_SPACE_ID, b.space.id].sort());
  });

  it('skips a space whose lock another replica holds, and the targets checked less than 10 minutes ago', async () => {
    const { db } = await import('@/server/db');
    const { checkSpaceUnderLock } = await import('./scheduler');
    const recent = new Date(Date.now() - 2 * 60_000);
    await storeCoolify(TEST_SPACE_ID, recent);

    // Another web replica holds the lock of this space.
    const other = createDb(url, { max: 1, applicationName: 'nuera-w3-scheduler-test' });
    try {
      const reserved = await other.$client.reserve();
      await reserved`select pg_advisory_lock(${0x4e75_4900}::int, hashtext(${TEST_SPACE_ID}))`;
      expect(await checkSpaceUnderLock(TEST_SPACE_ID)).toBe(false);
      await reserved`select pg_advisory_unlock(${0x4e75_4900}::int, hashtext(${TEST_SPACE_ID}))`;
      reserved.release();
    } finally {
      await other.$client.end({ timeout: 5 });
    }

    // Lock free: it runs, but Coolify was checked 2 minutes ago → skipped.
    expect(await checkSpaceUnderLock(TEST_SPACE_ID)).toBe(true);
    const [row] = await db.select().from(integrations).where(eq(integrations.spaceId, TEST_SPACE_ID));
    expect(row?.lastCheckedAt?.getTime()).toBe(recent.getTime());

    // Old enough: checked now (and the lock is released after the run).
    await db.update(integrations).set({ lastCheckedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(integrations.spaceId, TEST_SPACE_ID));
    expect(await checkSpaceUnderLock(TEST_SPACE_ID)).toBe(true);
    const [after] = await db.select().from(integrations).where(eq(integrations.spaceId, TEST_SPACE_ID));
    expect(after!.lastCheckedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const locks = await db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and classid = ${0x4e75_4900}`);
    expect(Number((locks[0] as { n: number }).n)).toBe(0);
  });

  it('rewrites the legacy ciphertexts of the integration tables bound to their row (compare-and-swap)', async () => {
    const { db } = await import('@/server/db');
    const { encryptJson, isBoundCipher, decryptJson, SecretScopes } = await import('@/server/security/crypto');
    const { ensurePresetServers } = await import('@/server/mcp/registry');
    await ensurePresetServers(TEST_SPACE_ID);
    await storeCoolify(TEST_SPACE_ID, new Date());
    // Legacy (unbound) values, as written before the multi-account update.
    await db.update(integrations).set({ secretsEncrypted: encryptJson({ token: 'legacy-coolify-token' }) }).where(eq(integrations.spaceId, TEST_SPACE_ID));
    const [figma] = await db.update(mcpServers).set({ secretsEncrypted: encryptJson({ headers: { 'X-Key': 'legacy-mcp-secret' } }) }).where(eq(mcpServers.name, 'figma')).returning();
    const { reencryptIntegrationSecrets } = await import('./scheduler');
    expect(await reencryptIntegrationSecrets()).toBe(2);
    const [coolify] = await db.select().from(integrations).where(eq(integrations.spaceId, TEST_SPACE_ID));
    expect(isBoundCipher(coolify!.secretsEncrypted!)).toBe(true);
    expect(decryptJson<{ token: string }>(coolify!.secretsEncrypted!, SecretScopes.integration(TEST_SPACE_ID, 'coolify')).token).toBe('legacy-coolify-token');
    const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, figma!.id));
    expect(decryptJson<{ headers: Record<string, string> }>(server!.secretsEncrypted!, SecretScopes.mcpServer(figma!.id)).headers['X-Key']).toBe('legacy-mcp-secret');
    // Second pass: nothing left to rewrite.
    expect(await reencryptIntegrationSecrets()).toBe(0);
  });
});
