import { environments, spaceMembers, spaceSettings, spaces, user, userPreferences } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/server/auth/session';
import { closeWebTestDb, prepareTenancyDatabase, useTestEncryptionKey } from './test/db';
import { createTestAccount, createTestEnvironment, testUser, truncateTenancy } from './test/fixtures';

/*
 * Request context: personal space resolution (one query) and self-healing, server none / active /
 * suspended / retired, the 5 s cache and its invalidation, requireEnvironment's refusal.
 */

const state = vi.hoisted(() => ({ current: null as CurrentUser | null }));

vi.mock('@/server/auth/session', async () => {
  const { AppError } = await import('@/server/errors');
  return {
    getCurrentUser: async () => state.current,
    requireUser: async () => {
      if (!state.current) throw new Error('NEXT_REDIRECT /connexion');
      return state.current;
    },
    requireUserForApi: async () => {
      if (!state.current) throw new AppError('UNAUTHORIZED');
      return state.current;
    },
    isInstanceAdmin: (u: CurrentUser) => u.role === 'owner' || u.role === 'admin',
  };
});

const context = await import('./context');
const { db } = await import('@/server/db');

beforeAll(async () => {
  await prepareTenancyDatabase('context');
  useTestEncryptionKey();
});

afterAll(async () => {
  await closeWebTestDb();
});

beforeEach(async () => {
  await truncateTenancy();
  context.invalidateContextCache();
  state.current = null;
});

describe('personalSpaceName', () => {
  it('follows the rule of migration 0002', () => {
    expect(context.personalSpaceName('Ethan Martin')).toBe("Espace d'Ethan");
    expect(context.personalSpaceName('Camille Laurent')).toBe('Espace de Camille');
    expect(context.personalSpaceName('hélène')).toBe("Espace d'hélène");
    expect(context.personalSpaceName('  ')).toBe('Espace personnel');
  });
});

describe('resolveContext', () => {
  it('returns the personal space and its active server', async () => {
    const owner = await createTestAccount({ role: 'owner', name: 'Ethan Martin' });
    const ctx = await context.resolveContext(owner.user);
    expect(ctx.space).toEqual({ id: owner.space.id, name: "Espace d'Ethan", kind: 'personal', role: 'owner' });
    expect(ctx.environment).toEqual({
      id: owner.environment!.id,
      name: 'VPS-3',
      location: null,
      status: 'active',
      isDefault: true,
      uptimeKey: 'runner',
      maxConcurrentSessions: 4,
    });
    expect(ctx.user).toBe(owner.user);
  });

  it('gives a non-default server its own uptime key', async () => {
    const member = await createTestAccount({ role: 'member', environment: { name: 'VPS-4', maxConcurrentSessions: 2 } });
    const ctx = await context.resolveContext(member.user);
    expect(ctx.environment).toMatchObject({ name: 'VPS-4', isDefault: false, uptimeKey: `runner:${member.environment!.id}`, maxConcurrentSessions: 2 });
  });

  it('has no server when none is assigned, or when it is retired; keeps a suspended one', async () => {
    const lonely = await createTestAccount({ environment: false });
    expect((await context.resolveContext(lonely.user)).environment).toBeNull();

    const retired = await createTestAccount({ environment: { status: 'retired' } });
    expect((await context.resolveContext(retired.user)).environment).toBeNull();

    const suspended = await createTestAccount({ environment: { status: 'suspended' } });
    expect((await context.resolveContext(suspended.user)).environment).toMatchObject({ status: 'suspended' });
  });

  it('picks the active server when a retired one exists in the same space', async () => {
    const account = await createTestAccount({ environment: { status: 'retired', name: 'Ancien' } });
    const fresh = await createTestEnvironment({ spaceId: account.space.id, name: 'Nouveau' });
    expect((await context.resolveContext(account.user)).environment).toMatchObject({ id: fresh.id, name: 'Nouveau' });
  });

  it('creates the missing personal space (membership, settings, preferences) idempotently', async () => {
    await db.insert(user).values({ id: 'legacy-user', name: 'Inès Durand', email: 'ines@example.test', role: 'member', twoFactorEnabled: true });
    const legacy = testUser({ id: 'legacy-user', name: 'Inès Durand', email: 'ines@example.test', role: 'member' });

    const [first, second] = await Promise.all([context.resolveContext(legacy), context.resolveContext(legacy)]);
    expect(first.space).toMatchObject({ name: "Espace d'Inès", kind: 'personal', role: 'owner' });
    expect(second.space.id).toBe(first.space.id);
    expect(first.environment).toBeNull();

    expect(await db.select().from(spaces).where(eq(spaces.ownerUserId, 'legacy-user'))).toHaveLength(1);
    expect(await db.select().from(spaceMembers).where(eq(spaceMembers.userId, 'legacy-user'))).toHaveLength(1);
    expect(await db.select().from(spaceSettings).where(eq(spaceSettings.spaceId, first.space.id))).toHaveLength(1);
    expect(await db.select().from(userPreferences).where(eq(userPreferences.userId, 'legacy-user'))).toHaveLength(1);
  });

  it('repairs a space whose membership is missing', async () => {
    const account = await createTestAccount({ environment: false });
    await db.delete(spaceMembers).where(eq(spaceMembers.userId, account.user.id));
    const ctx = await context.resolveContext(account.user);
    expect(ctx.space.id).toBe(account.space.id);
  });

  it("lets the owner adopt the ownerless « Espace initial » and its server; never a member", async () => {
    // Database that had data but no account (migration 0002, step 4).
    const [initial] = await db.insert(spaces).values({ name: 'Espace initial', kind: 'personal' }).returning({ id: spaces.id });
    const server = await createTestEnvironment({ spaceId: initial!.id, configSource: 'env', isDefault: true });

    await db.insert(user).values({ id: 'member-first', name: 'Camille Laurent', email: 'camille@example.test', role: 'member', twoFactorEnabled: true });
    const member = await context.resolveContext(testUser({ id: 'member-first', name: 'Camille Laurent', email: 'camille@example.test', role: 'member' }));
    expect(member.space.id).not.toBe(initial!.id);
    expect(member.environment).toBeNull();

    await db.insert(user).values({ id: 'owner-late', name: 'Ethan Martin', email: 'ethan@example.test', role: 'owner', twoFactorEnabled: true });
    const owner = testUser({ id: 'owner-late', name: 'Ethan Martin', email: 'ethan@example.test', role: 'owner' });
    const [first, second] = await Promise.all([context.resolveContext(owner), context.resolveContext(owner)]);
    expect(first.space).toEqual({ id: initial!.id, name: 'Espace initial', kind: 'personal', role: 'owner' });
    expect(second.space.id).toBe(initial!.id);
    expect(first.environment?.id).toBe(server.id);
    expect(await db.select().from(spaces).where(eq(spaces.ownerUserId, 'owner-late'))).toHaveLength(1);
    expect(await db.select().from(spaceMembers).where(eq(spaceMembers.spaceId, initial!.id))).toEqual([
      expect.objectContaining({ userId: 'owner-late', role: 'owner' }),
    ]);
  });

  it("never resolves another account's space", async () => {
    const a = await createTestAccount({ role: 'owner' });
    const b = await createTestAccount({ role: 'member' });
    // B made a member of A's space must still land in its OWN personal space (v1).
    await db.insert(spaceMembers).values({ spaceId: a.space.id, userId: b.user.id, role: 'member' });
    const ctx = await context.resolveContext(b.user);
    expect(ctx.space.id).toBe(b.space.id);
    expect(ctx.environment?.id).toBe(b.environment!.id);
  });

  it('refuses an archived space (deleted account)', async () => {
    const account = await createTestAccount({ environment: false });
    await db.update(spaces).set({ archivedAt: new Date() }).where(eq(spaces.id, account.space.id));
    await expect(context.resolveContext(account.user)).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'ACCOUNT_DISABLED' });
  });

  it('caches the space and server 5 s per account until invalidated', async () => {
    const account = await createTestAccount({ environment: { name: 'VPS-4' } });
    expect((await context.resolveContext(account.user)).environment?.name).toBe('VPS-4');
    await db.update(environments).set({ name: 'VPS-5' }).where(eq(environments.id, account.environment!.id));
    expect((await context.resolveContext(account.user)).environment?.name).toBe('VPS-4');
    context.invalidateContextCache(account.user.id);
    expect((await context.resolveContext(account.user)).environment?.name).toBe('VPS-5');

    await db.update(environments).set({ status: 'retired' }).where(eq(environments.id, account.environment!.id));
    context.invalidateContextCache();
    expect((await context.resolveContext(account.user)).environment).toBeNull();
  });

  it('never caches the user itself', async () => {
    const account = await createTestAccount({ role: 'member' });
    await context.resolveContext(account.user);
    const renamed = { ...account.user, name: 'Autre nom', role: 'admin' as const };
    const ctx = await context.resolveContext(renamed);
    expect(ctx.user).toBe(renamed);
  });
});

describe('requireContext / requireContextForApi / getRequestContext', () => {
  it('resolve the signed-in account, refuse a signed-out request', async () => {
    const account = await createTestAccount({ role: 'member' });
    await expect(context.requireContextForApi()).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    await expect(context.requireContext()).rejects.toThrow('NEXT_REDIRECT');
    expect(await context.getRequestContext()).toBeNull();

    state.current = account.user;
    expect((await context.requireContextForApi()).space.id).toBe(account.space.id);
    expect((await context.requireContext()).environment?.id).toBe(account.environment!.id);
    expect((await context.getRequestContext())?.space.id).toBe(account.space.id);
  });
});

describe('requireEnvironment', () => {
  it('returns the server and its runner client, or CONFLICT NO_ENVIRONMENT', async () => {
    const lonely = await createTestAccount({ environment: false });
    const ctx = await context.resolveContext(lonely.user);
    let error: unknown;
    try {
      context.requireEnvironment(ctx);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'CONFLICT',
      status: 409,
      reason: 'NO_ENVIRONMENT',
      message: "Aucun serveur ne vous est encore attribué : un administrateur doit vous en attribuer un.",
    });
    const { toErrorBody } = await import('@/server/errors');
    expect(toErrorBody(error).error.reason).toBe('NO_ENVIRONMENT');

    const equipped = await createTestAccount({ environment: { name: 'VPS-4' } });
    const { environment, runner } = context.requireEnvironment(await context.resolveContext(equipped.user));
    expect(environment.id).toBe(equipped.environment!.id);
    expect(typeof runner.health).toBe('function');
    const [row] = await db.select({ id: environments.id }).from(environments).where(and(eq(environments.spaceId, equipped.space.id)));
    expect(row?.id).toBe(environment.id);
  });
});
