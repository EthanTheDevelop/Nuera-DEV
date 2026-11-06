import { appSettings, auditLog, environments, spaceSettings } from '@nuera/db/schema';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dropSuiteDatabase, pgAvailable, prepareSuiteDatabase, resetAccounts, type TwoAccounts } from '@/server/notifications/test/db';

/**
 * Settings by scope (docs/MULTICOMPTE.md §8): instance (administrators), server (name/location by an
 * administrator, limits by the space owner under the ceiling), space (its owner), account (itself);
 * PATCH /api/settings flat keys routed to their scope; a foreign space or server is « unknown ».
 */

const SUITE = 'settings';
const available = await pgAvailable('settings.test');
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

describe.skipIf(!available)('réglages par portée', () => {
  let accounts: TwoAccounts;
  const owner = () => ({ userId: accounts.a.userId, role: 'owner' as const });
  const member = () => ({ userId: accounts.b.userId, role: 'member' as const });
  const patchActorA = () => ({ ...owner(), spaceId: accounts.a.spaceId, environmentId: accounts.a.environmentId });
  const patchActorB = () => ({ ...member(), spaceId: accounts.b.spaceId, environmentId: accounts.b.environmentId });

  beforeAll(async () => {
    await prepareSuiteDatabase(SUITE);
  });

  afterAll(async () => {
    await dropSuiteDatabase(SUITE);
  });

  beforeEach(async () => {
    accounts = await resetAccounts();
    const { invalidateSettingsCache } = await import('./settings');
    invalidateSettingsCache();
  });

  async function journal() {
    const { db } = await import('@/server/db');
    return db.select().from(auditLog).orderBy(auditLog.id);
  }

  it('instance: read from its own columns only, changed by administrators only, audited in the instance journal', async () => {
    const { getInstanceSettings, getWebSessionPolicy, updateInstanceSettings } = await import('./settings');
    const { db } = await import('@/server/db');
    // Deprecated columns hold values that must never surface.
    await db.update(appSettings).set({ maxConcurrentSessions: 9, theme: 'dark', serverName: 'ANCIEN' }).where(eq(appSettings.id, 1));
    const initial = await getInstanceSettings();
    expect(Object.keys(initial).sort()).toEqual(['forceBlockBypassPermissions', 'invitationTtlHours', 'updatedAt', 'webSessionIdleHours', 'webSessionMaxDays']);
    expect(initial).toMatchObject({ webSessionIdleHours: 12, webSessionMaxDays: 30, invitationTtlHours: 48, forceBlockBypassPermissions: false });

    await expect(updateInstanceSettings({ webSessionIdleHours: 2 }, member())).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Réglage réservé aux administrateurs.' });
    await expect(updateInstanceSettings({ webSessionIdleHours: 0 }, owner())).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateInstanceSettings({ projectsRoot: '/srv' } as never, owner())).rejects.toMatchObject({ code: 'VALIDATION' });

    const updated = await updateInstanceSettings({ webSessionIdleHours: 6, invitationTtlHours: 24 }, { userId: accounts.a.userId, role: 'admin' });
    expect(updated).toMatchObject({ webSessionIdleHours: 6, invitationTtlHours: 24 });
    // The cache was invalidated: the auth layer sees the new policy at once.
    expect(await getWebSessionPolicy()).toEqual({ idleHours: 6, maxDays: 30 });
    const [entry] = await journal();
    expect(entry).toMatchObject({
      action: 'instance.settings_updated',
      actorUserId: accounts.a.userId,
      actorLabel: 'ethan@example.test',
      spaceId: null,
      metadata: { scope: 'instance', changes: { webSessionIdleHours: { from: 12, to: 6 }, invitationTtlHours: { from: 48, to: 24 } } },
    });
    // No change: no write, no journal line.
    await updateInstanceSettings({ webSessionIdleHours: 6 }, owner());
    expect(await journal()).toHaveLength(1);
  });

  it('space: each owner changes its own space; another space answers like an unknown one', async () => {
    const { getSpaceSettings, updateSpaceSettings } = await import('./settings');
    const { a, b } = accounts;
    const updated = await updateSpaceSettings(a.spaceId, { permissionWaitSeconds: 300, defaultModel: ' opus ', defaultEffort: '' }, { userId: a.userId });
    expect(updated).toMatchObject({ spaceId: a.spaceId, permissionWaitSeconds: 300, defaultModel: 'opus', defaultEffort: null });
    expect((await getSpaceSettings(b.spaceId))?.permissionWaitSeconds).toBe(120);

    // B on A's space, or anybody on an unknown space: the same NOT_FOUND, nothing written.
    const foreign = await updateSpaceSettings(a.spaceId, { permissionWaitSeconds: 10 }, { userId: b.userId }).catch((error: unknown) => error);
    const unknown = await updateSpaceSettings(UNKNOWN, { permissionWaitSeconds: 10 }, { userId: b.userId }).catch((error: unknown) => error);
    expect(foreign).toMatchObject({ code: 'NOT_FOUND', message: 'Élément introuvable.' });
    expect(unknown).toMatchObject({ code: 'NOT_FOUND', message: (foreign as Error).message });
    expect((await getSpaceSettings(a.spaceId))?.permissionWaitSeconds).toBe(300);
    expect(await getSpaceSettings(UNKNOWN)).toBeNull();
    expect(await getSpaceSettings('pas-un-uuid')).toBeNull();

    const entries = await journal();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'settings.updated', spaceId: a.spaceId, targetType: 'space', metadata: { scope: 'space' } });
  });

  it('space: a member that is not the owner of the space is refused', async () => {
    const { updateSpaceSettings } = await import('./settings');
    const { db } = await import('@/server/db');
    const { a, b } = accounts;
    await db.execute(sql`insert into space_members (space_id, user_id, role) values (${a.spaceId}, ${b.userId}, 'member')`);
    await expect(updateSpaceSettings(a.spaceId, { worktreeStaleDays: 7 }, { userId: b.userId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: "Réglage réservé au propriétaire de l'espace.",
    });
  });

  it("automatic resumption after the usage limit: off by default, per space, its instruction defaulted", async () => {
    const { getEffectiveSessionPolicy, getSpaceSettings, updateSpaceSettings } = await import('./settings');
    const { a, b } = accounts;
    expect(await getSpaceSettings(a.spaceId)).toMatchObject({ autoResumeAfterLimit: false, autoResumeInstruction: null });
    expect(await getEffectiveSessionPolicy(a.spaceId)).toMatchObject({ autoResumeAfterLimit: false, autoResumeInstruction: "Continue là où tu t'es arrêté." });

    await updateSpaceSettings(a.spaceId, { autoResumeAfterLimit: true, autoResumeInstruction: '  Reprends les tests.  ' }, { userId: a.userId });
    expect(await getEffectiveSessionPolicy(a.spaceId)).toMatchObject({ autoResumeAfterLimit: true, autoResumeInstruction: 'Reprends les tests.' });
    expect(await getEffectiveSessionPolicy(b.spaceId)).toMatchObject({ autoResumeAfterLimit: false });
    // Empty: back to the default instruction.
    await updateSpaceSettings(a.spaceId, { autoResumeInstruction: '' }, { userId: a.userId });
    expect((await getSpaceSettings(a.spaceId))?.autoResumeInstruction).toBeNull();
    expect((await getEffectiveSessionPolicy(a.spaceId)).autoResumeInstruction).toBe("Continue là où tu t'es arrêté.");
    await expect(updateSpaceSettings(a.spaceId, { autoResumeInstruction: 'x'.repeat(2001) }, { userId: a.userId })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateSpaceSettings(a.spaceId, { autoResumeAfterLimit: true }, { userId: b.userId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const entries = await journal();
    expect(JSON.stringify(entries.map((entry) => entry.summary))).toContain("reprise automatique après la limite d'utilisation");
  });

  it('bypass block: effective = instance OR space, and the default mode never stays « bypass » while blocked', async () => {
    const { getEffectiveSessionPolicy, updateInstanceSettings, updateSpaceSettings } = await import('./settings');
    const { a, b } = accounts;
    await expect(updateSpaceSettings(a.spaceId, { defaultPermissionMode: 'bypassPermissions' }, { userId: a.userId })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'Le mode sans autorisation est bloqué.',
    });
    await updateSpaceSettings(a.spaceId, { blockBypassPermissions: false, defaultPermissionMode: 'bypassPermissions' }, { userId: a.userId });
    expect(await getEffectiveSessionPolicy(a.spaceId)).toMatchObject({
      blockBypassPermissions: false,
      blockBypassForcedByInstance: false,
      defaultPermissionMode: 'bypassPermissions',
    });
    expect(await getEffectiveSessionPolicy(b.spaceId)).toMatchObject({ blockBypassPermissions: true, defaultPermissionMode: 'manual', permissionWaitSeconds: 120 });

    await updateInstanceSettings({ forceBlockBypassPermissions: true }, owner());
    expect(await getEffectiveSessionPolicy(a.spaceId)).toMatchObject({
      blockBypassPermissions: true,
      blockBypassForcedByInstance: true,
      defaultPermissionMode: 'manual',
    });
    await expect(updateSpaceSettings(a.spaceId, { defaultPermissionMode: 'bypassPermissions' }, { userId: a.userId })).rejects.toMatchObject({
      detail: expect.stringContaining('Un administrateur bloque'),
    });
    // A's stored « bypass » default predates the instance block: unrelated changes still go
    // through (the effective mode is already « manual »), and moving away from bypass too.
    expect((await updateSpaceSettings(a.spaceId, { permissionWaitSeconds: 200 }, { userId: a.userId })).permissionWaitSeconds).toBe(200);
    expect(await getEffectiveSessionPolicy(a.spaceId)).toMatchObject({ defaultPermissionMode: 'manual', permissionWaitSeconds: 200 });
    expect((await updateSpaceSettings(a.spaceId, { defaultPermissionMode: 'plan' }, { userId: a.userId })).defaultPermissionMode).toBe('plan');
    await expect(getEffectiveSessionPolicy(UNKNOWN)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("server limits: the space owner, under the administrator's ceiling; never another space's server", async () => {
    const { getEnvironmentSettings, updateEnvironmentLimits } = await import('./settings');
    const { db } = await import('@/server/db');
    const { seedEnvironment } = await import('@nuera/db/test');
    const { a, b } = accounts;
    const updated = await updateEnvironmentLimits(a.environmentId!, { maxConcurrentSessions: 6, sessionMemoryLimitMb: 2048 }, { userId: a.userId });
    expect(updated).toMatchObject({ id: a.environmentId, maxConcurrentSessions: 6, sessionMemoryLimitMb: 2048, maxConcurrentSessionsCap: 16 });
    // Never the token, URL or database role.
    expect(Object.keys(updated)).not.toEqual(expect.arrayContaining(['tokenEncrypted']));
    expect(updated).not.toHaveProperty('tokenHash');
    expect(updated).not.toHaveProperty('url');

    await db.update(environments).set({ maxConcurrentSessionsCap: 4 }).where(eq(environments.id, b.environmentId!));
    await expect(updateEnvironmentLimits(b.environmentId!, { maxConcurrentSessions: 5 }, { userId: b.userId })).rejects.toMatchObject({
      code: 'VALIDATION',
      detail: expect.stringContaining('4 sessions parallèles au maximum sur ce serveur (plafond fixé par un administrateur).'),
    });
    expect((await updateEnvironmentLimits(b.environmentId!, { maxConcurrentSessions: 4 }, { userId: b.userId })).maxConcurrentSessions).toBe(4);

    // B on A's server, an unassigned server, an unknown id: the same NOT_FOUND, nothing written.
    const pending = await seedEnvironment(db, { spaceId: null, name: 'VPS-9' });
    for (const id of [a.environmentId!, pending, UNKNOWN, 'pas-un-uuid']) {
      await expect(updateEnvironmentLimits(id, { maxConcurrentSessions: 1 }, { userId: b.userId })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Élément introuvable.' });
    }
    expect((await getEnvironmentSettings(a.environmentId!))?.maxConcurrentSessions).toBe(6);

    await db.update(environments).set({ status: 'retired' }).where(eq(environments.id, b.environmentId!));
    await expect(updateEnvironmentLimits(b.environmentId!, { maxConcurrentSessions: 2 }, { userId: b.userId })).rejects.toMatchObject({ code: 'CONFLICT' });

    const entries = await journal();
    expect(entries[0]).toMatchObject({ action: 'settings.updated', spaceId: a.spaceId, environmentId: a.environmentId, metadata: { scope: 'environment' } });
  });

  it('server name and location: administrators only, any server', async () => {
    const { getEnvironmentSettings, updateEnvironmentIdentity } = await import('./settings');
    const { a, b } = accounts;
    await expect(updateEnvironmentIdentity(b.environmentId!, { name: 'Mon serveur' }, member())).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Réglage réservé aux administrateurs.',
    });
    const renamed = await updateEnvironmentIdentity(b.environmentId!, { name: ' VPS-5 ', location: 'Gravelines' }, owner());
    expect(renamed).toMatchObject({ name: 'VPS-5', location: 'Gravelines' });
    expect((await getEnvironmentSettings(a.environmentId!))?.name).toBe('VPS-3');
    await expect(updateEnvironmentIdentity(UNKNOWN, { name: 'x' }, owner())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateEnvironmentIdentity(b.environmentId!, { name: '' }, owner())).rejects.toMatchObject({ code: 'VALIDATION' });
    const [entry] = await journal();
    expect(entry).toMatchObject({ action: 'environment.updated', environmentId: b.environmentId, spaceId: b.spaceId, summary: 'serveur « VPS-5 » modifié : nom du serveur, emplacement du serveur' });
  });

  it('preferences: per account, Git identity validated, audited for that account', async () => {
    const { getUserPreferences, updateUserPreferences } = await import('./settings');
    const { a, b } = accounts;
    const updated = await updateUserPreferences(a.userId, { theme: 'dark', gitAuthorName: 'Ethan N.', gitAuthorEmail: 'Ethan@Nuera.Studio' });
    expect(updated).toMatchObject({ userId: a.userId, theme: 'dark', locale: 'fr', gitAuthorName: 'Ethan N.', gitAuthorEmail: 'ethan@nuera.studio' });
    expect(await getUserPreferences(b.userId)).toMatchObject({ theme: 'light', gitAuthorName: null, gitAuthorEmail: null });
    await expect(updateUserPreferences(a.userId, { gitAuthorEmail: 'pas une adresse' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateUserPreferences(a.userId, { gitAuthorName: 'Ethan <root@x>' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateUserPreferences(a.userId, { gitAuthorName: 'Ethan\nCommitter: x' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateUserPreferences(a.userId, { locale: 'en' as 'fr' })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Clearing the identity falls back to the account (null).
    expect(await updateUserPreferences(a.userId, { gitAuthorName: '', gitAuthorEmail: '' })).toMatchObject({ gitAuthorName: null, gitAuthorEmail: null });
    await expect(updateUserPreferences('compte-inconnu', { theme: 'dark' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await getUserPreferences('compte-inconnu')).toBeNull();
    const entries = await journal();
    expect(entries[0]).toMatchObject({ action: 'settings.updated', actorUserId: a.userId, subjectUserId: a.userId, spaceId: null, metadata: { scope: 'user' } });
  });

  it('caches per scope id and invalidates on update', async () => {
    const { getSpaceSettings, updateSpaceSettings } = await import('./settings');
    const { db } = await import('@/server/db');
    const { a, b } = accounts;
    expect((await getSpaceSettings(a.spaceId))?.worktreeStaleDays).toBe(30);
    // A direct write is not seen until the cache expires or is invalidated…
    await db.update(spaceSettings).set({ worktreeStaleDays: 3 }).where(eq(spaceSettings.spaceId, a.spaceId));
    expect((await getSpaceSettings(a.spaceId))?.worktreeStaleDays).toBe(30);
    // …an update of B's space does not touch A's entry, an update of A's space does.
    await updateSpaceSettings(b.spaceId, { worktreeStaleDays: 9 }, { userId: b.userId });
    expect((await getSpaceSettings(a.spaceId))?.worktreeStaleDays).toBe(30);
    expect((await getSpaceSettings(b.spaceId))?.worktreeStaleDays).toBe(9);
    await updateSpaceSettings(a.spaceId, { worktreeStaleDays: 14 }, { userId: a.userId });
    expect((await getSpaceSettings(a.spaceId))?.worktreeStaleDays).toBe(14);
    // A caller mutating its result never alters what the next caller reads.
    const copy = (await getSpaceSettings(a.spaceId))!;
    copy.worktreeStaleDays = 99;
    expect((await getSpaceSettings(a.spaceId))?.worktreeStaleDays).toBe(14);
  });

  describe('applySettingsPatch (PATCH /api/settings, flat keys)', () => {
    it('routes every key to its scope and reports per key', async () => {
      const { applySettingsPatch, getEnvironmentSettings, getInstanceSettings, getSpaceSettings, getUserPreferences } = await import('./settings');
      const { a } = accounts;
      const result = await applySettingsPatch(patchActorA(), {
        webSessionMaxDays: 14,
        serverName: 'VPS-3',
        serverLocation: 'Roubaix',
        maxConcurrentSessions: 5,
        permissionWaitSeconds: 60,
        theme: 'system',
        gitAuthorEmail: 'ethan@nuera.studio',
        projectsRoot: '/srv/dev',
      });
      expect(result.error).toBeNull();
      expect(result.results).toEqual({
        webSessionMaxDays: { status: 'updated' },
        serverName: { status: 'unchanged' },
        serverLocation: { status: 'updated' },
        maxConcurrentSessions: { status: 'updated' },
        permissionWaitSeconds: { status: 'updated' },
        theme: { status: 'updated' },
        gitAuthorEmail: { status: 'updated' },
        projectsRoot: { status: 'ignored', message: expect.stringContaining('NUERA_PROJECTS_ROOT') },
      });
      expect(result.updated.sort()).toEqual(['gitAuthorEmail', 'maxConcurrentSessions', 'permissionWaitSeconds', 'serverLocation', 'theme', 'webSessionMaxDays']);
      expect((await getInstanceSettings()).webSessionMaxDays).toBe(14);
      expect(await getEnvironmentSettings(a.environmentId!)).toMatchObject({ location: 'Roubaix', maxConcurrentSessions: 5 });
      expect((await getSpaceSettings(a.spaceId))?.permissionWaitSeconds).toBe(60);
      expect(await getUserPreferences(a.userId)).toMatchObject({ theme: 'system', gitAuthorEmail: 'ethan@nuera.studio' });
      // One journal line per scope, each with its scope.
      const scopes = (await journal()).map((entry) => [entry.action, (entry.metadata as { scope: string }).scope]);
      expect(scopes).toEqual([
        ['instance.settings_updated', 'instance'],
        ['environment.updated', 'environment'],
        ['settings.updated', 'environment'],
        ['settings.updated', 'space'],
        ['settings.updated', 'user'],
      ]);
    });

    it('a member: instance keys and server identity refused (403), its own scopes applied', async () => {
      const { applySettingsPatch, getInstanceSettings, getSpaceSettings, getUserPreferences } = await import('./settings');
      const { b } = accounts;
      const result = await applySettingsPatch(patchActorB(), { webSessionIdleHours: 1, serverName: 'Le mien', worktreeStaleDays: 10, theme: 'dark' });
      expect(result.results.webSessionIdleHours).toEqual({ status: 'refused', code: 'FORBIDDEN', message: 'Réglage réservé aux administrateurs.' });
      expect(result.results.serverName).toEqual({ status: 'refused', code: 'FORBIDDEN', message: 'Réglage réservé aux administrateurs.' });
      expect(result.results.worktreeStaleDays).toEqual({ status: 'updated' });
      expect(result.results.theme).toEqual({ status: 'updated' });
      expect(result.error).toMatchObject({ code: 'FORBIDDEN', status: 403, message: 'Réglage réservé aux administrateurs.' });
      expect((await getInstanceSettings()).webSessionIdleHours).toBe(12);
      expect((await getSpaceSettings(b.spaceId))?.worktreeStaleDays).toBe(10);
      expect((await getUserPreferences(b.userId))?.theme).toBe('dark');
      expect(await journal()).toHaveLength(2);
    });

    it('writes nothing when a key is unknown or a value invalid', async () => {
      const { applySettingsPatch, getSpaceSettings } = await import('./settings');
      const { a } = accounts;
      await expect(applySettingsPatch(patchActorA(), { worktreeStaleDays: 10, nope: 1 })).rejects.toMatchObject({ code: 'VALIDATION', detail: 'nope : réglage inconnu' });
      await expect(applySettingsPatch(patchActorA(), { worktreeStaleDays: 10, permissionWaitSeconds: 5 })).rejects.toMatchObject({
        code: 'VALIDATION',
        detail: 'permissionWaitSeconds : 10 s au minimum',
      });
      await expect(applySettingsPatch(patchActorA(), {})).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(applySettingsPatch(patchActorA(), 'texte')).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(applySettingsPatch(patchActorA(), { projectsRoot: 3 })).resolves.toMatchObject({ results: { projectsRoot: { status: 'ignored' } } });
      expect((await getSpaceSettings(a.spaceId))?.worktreeStaleDays).toBe(30);
      expect(await journal()).toHaveLength(0);
    });

    it('without a server: the server keys answer NO_ENVIRONMENT, the rest applies', async () => {
      const { applySettingsPatch } = await import('./settings');
      const { b } = accounts;
      const result = await applySettingsPatch({ ...patchActorB(), environmentId: null }, { maxConcurrentSessions: 2, remoteControlByDefault: true });
      expect(result.results.maxConcurrentSessions).toEqual({
        status: 'refused',
        code: 'CONFLICT',
        message: 'Aucun serveur ne vous est encore attribué : un administrateur doit vous en attribuer un.',
      });
      expect(result.results.remoteControlByDefault).toEqual({ status: 'updated' });
      // A forged context (another space's server) is refused like an unknown server.
      const forged = await applySettingsPatch({ ...patchActorB(), environmentId: accounts.a.environmentId }, { maxConcurrentSessions: 1 });
      expect(forged.results.maxConcurrentSessions).toMatchObject({ status: 'refused', code: 'NOT_FOUND' });
      expect(b.userId).toBeTruthy();
    });
  });

  it('getSettingsView: what each account may change', async () => {
    const { getSettingsView, updateInstanceSettings } = await import('./settings');
    const ownerView = await getSettingsView(patchActorA());
    expect(Object.values(ownerView.editable).every(Boolean)).toBe(true);
    expect(ownerView.environment?.name).toBe('VPS-3');

    const memberView = await getSettingsView(patchActorB());
    expect(memberView.editable).toMatchObject({
      webSessionIdleHours: false,
      invitationTtlHours: false,
      forceBlockBypassPermissions: false,
      serverName: false,
      serverLocation: false,
      maxConcurrentSessions: true,
      blockBypassPermissions: true,
      worktreeStaleDays: true,
      theme: true,
      gitAuthorName: true,
    });
    expect(memberView.environment?.name).toBe('VPS-4');

    await updateInstanceSettings({ forceBlockBypassPermissions: true }, owner());
    const forced = await getSettingsView(patchActorB());
    expect(forced.editable.blockBypassPermissions).toBe(false);
    expect(forced.effective.blockBypassPermissions).toBe(true);

    // A context pointing at another space's server shows no server; a foreign space is unknown.
    expect((await getSettingsView({ ...patchActorB(), environmentId: accounts.a.environmentId })).environment).toBeNull();
    await expect(getSettingsView({ ...patchActorB(), spaceId: accounts.a.spaceId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
