import { environments } from '@nuera/db/schema';
import { hashToken } from '@nuera/shared/tokens';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWebTestDb, prepareTenancyDatabase, useTestEncryptionKey } from '@/server/tenancy/test/db';
import { createTestAccount, createTestEnvironment, truncateTenancy } from '@/server/tenancy/test/fixtures';
import { bearerToken, isValidRunnerAuthorization, resolveRunnerCaller } from './runner-token';

const TOKEN = 'rUnNeR-tOkEn-0123456789abcdef';

describe('isValidRunnerAuthorization', () => {
  it('accepts exactly "Bearer <RUNNER_TOKEN>"', () => {
    expect(isValidRunnerAuthorization(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isValidRunnerAuthorization(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('refuses wrong, partial or malformed values', () => {
    expect(isValidRunnerAuthorization(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isValidRunnerAuthorization(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(isValidRunnerAuthorization(TOKEN, TOKEN)).toBe(false);
    expect(isValidRunnerAuthorization(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(isValidRunnerAuthorization(`Bearer ${TOKEN} extra`, TOKEN)).toBe(false);
    expect(isValidRunnerAuthorization('Bearer ', TOKEN)).toBe(false);
    expect(isValidRunnerAuthorization(null, TOKEN)).toBe(false);
  });

  it('refuses everything when RUNNER_TOKEN is missing or too short', () => {
    expect(isValidRunnerAuthorization('Bearer ', '')).toBe(false);
    expect(isValidRunnerAuthorization('Bearer court', 'court')).toBe(false);
    expect(isValidRunnerAuthorization(`Bearer ${TOKEN}`, undefined)).toBe(false);
  });

  it('extracts exactly one bearer value', () => {
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerToken(`Bearer ${TOKEN} extra`)).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('resolveRunnerCaller', () => {
  beforeAll(async () => {
    await prepareTenancyDatabase('runner_token');
    useTestEncryptionKey();
  });

  afterAll(async () => {
    await closeWebTestDb();
  });

  beforeEach(async () => {
    vi.stubEnv('RUNNER_TOKEN', TOKEN);
    await truncateTenancy();
  });

  it('recognises the default server by RUNNER_TOKEN', async () => {
    const owner = await createTestAccount({ role: 'owner' });
    expect(await resolveRunnerCaller(`Bearer ${TOKEN}`)).toEqual({
      id: owner.environment!.id,
      name: 'VPS-3',
      spaceId: owner.space.id,
      isDefault: true,
      status: 'active',
    });
  });

  it('recognises another server by the sha256 of its token, current or being rotated in', async () => {
    const member = await createTestAccount({ environment: { name: 'VPS-4', nextToken: 'nrt_next-token-for-tests-0123456789' } });
    const expected = { id: member.environment!.id, name: 'VPS-4', spaceId: member.space.id, isDefault: false, status: 'active' };
    expect(await resolveRunnerCaller(`Bearer ${member.token}`)).toEqual(expected);
    expect(await resolveRunnerCaller('Bearer nrt_next-token-for-tests-0123456789')).toEqual(expected);
    // A callback made with the rotated token promotes it: the old token stops working.
    const { db: appDb } = await import('@/server/db');
    const [row] = await appDb.select({ tokenHash: environments.tokenHash, nextTokenHash: environments.nextTokenHash }).from(environments).where(eq(environments.id, member.environment!.id));
    expect(row).toEqual({ tokenHash: hashToken('nrt_next-token-for-tests-0123456789'), nextTokenHash: null });
    expect(await resolveRunnerCaller(`Bearer ${member.token}`)).toBeNull();
    expect(await resolveRunnerCaller('Bearer nrt_next-token-for-tests-0123456789')).toEqual(expected);

    const unassigned = await createTestEnvironment({ spaceId: null, name: 'VPS-9' });
    expect(await resolveRunnerCaller(`Bearer ${unassigned.token}`)).toMatchObject({ id: unassigned.id, spaceId: null, status: 'pending' });
  });

  it('answers null for an unknown, short or malformed token (→ 401)', async () => {
    await createTestAccount({ role: 'owner' });
    await createTestAccount({ environment: { name: 'VPS-4' } });
    for (const header of [undefined, null, '', 'Bearer wrong-token-wrong-token-wrong', `Basic ${TOKEN}`, TOKEN, 'Bearer short']) {
      expect(await resolveRunnerCaller(header)).toBeNull();
    }
  });

  it("never lets the default server's token be looked up as a hashed one, nor a stale RUNNER_TOKEN", async () => {
    const owner = await createTestAccount({ role: 'owner' });
    // RUNNER_TOKEN rotated on the web: the old token no longer designates the default server,
    // even though its fingerprint may still be recorded.
    vi.stubEnv('RUNNER_TOKEN', 'a-brand-new-runner-token-0123456789');
    expect(await resolveRunnerCaller(`Bearer ${TOKEN}`)).toBeNull();
    expect(await resolveRunnerCaller('Bearer a-brand-new-runner-token-0123456789')).toMatchObject({ id: owner.environment!.id });
  });

  it('refuses a suspended or retired server with 403', async () => {
    const member = await createTestAccount({ environment: { name: 'VPS-4' } });
    const { db: appDb } = await import('@/server/db');
    for (const status of ['suspended', 'retired'] as const) {
      await appDb.update(environments).set({ status }).where(eq(environments.id, member.environment!.id));
      await expect(resolveRunnerCaller(`Bearer ${member.token}`)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
        message: 'Ce serveur est suspendu.',
      });
    }
    // A suspended server presenting its rotated token is refused, and nothing is promoted.
    const rotating = await createTestAccount({ environment: { name: 'VPS-5', nextToken: 'nrt_next-token-of-vps5-0123456789' } });
    await appDb.update(environments).set({ status: 'suspended' }).where(eq(environments.id, rotating.environment!.id));
    await expect(resolveRunnerCaller('Bearer nrt_next-token-of-vps5-0123456789')).rejects.toMatchObject({ status: 403 });
    const [kept] = await appDb.select({ nextTokenHash: environments.nextTokenHash }).from(environments).where(eq(environments.id, rotating.environment!.id));
    expect(kept!.nextTokenHash).toBe(hashToken('nrt_next-token-of-vps5-0123456789'));

    const owner = await createTestAccount({ role: 'owner' });
    await appDb.update(environments).set({ status: 'suspended' }).where(eq(environments.id, owner.environment!.id));
    await expect(resolveRunnerCaller(`Bearer ${TOKEN}`)).rejects.toMatchObject({ status: 403 });
  });
});
