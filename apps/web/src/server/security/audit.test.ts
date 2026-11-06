import { auditLog } from '@nuera/db/schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dropSuiteDatabase, pgAvailable, prepareSuiteDatabase, resetAccounts, type TwoAccounts } from '@/server/notifications/test/db';

/**
 * Journal (docs/MULTICOMPTE.md §9): columns of the multi-account model, the personal journal of one
 * account (never another account's or another space's rows) and the instance journal of the
 * administrators (account and instance events only).
 */

const SUITE = 'audit';
const available = await pgAvailable('audit.test');

describe('sanitizeMetadata', () => {
  it('drops secret-looking keys recursively and truncates long strings', async () => {
    const { sanitizeMetadata } = await import('./audit');
    const clean = sanitizeMetadata({ token: 'x', nested: { password: 'y', ok: 'z'.repeat(600) }, list: [{ apiKey: 'k', n: 1 }] }) as Record<string, unknown>;
    expect(clean).not.toHaveProperty('token');
    expect(clean.nested).toEqual({ ok: `${'z'.repeat(500)}…` });
    expect(clean.list).toEqual([{ n: 1 }]);
  });
});

describe('AUDIT_ACTIONS', () => {
  it('lists every account, administration, server, instance and security action written by the web app', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { AUDIT_ACTIONS } = await import('./audit');
    const catalogue = new Set<string>(Object.values(AUDIT_ACTIONS));
    const root = path.resolve(import.meta.dirname, '../..');
    const files = (await readdir(root, { recursive: true }))
      .map(String)
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.split(/[\\/]/).includes('test'));
    const written = new Set<string>();
    for (const file of files) {
      const source = await readFile(path.join(root, file), 'utf8');
      for (const match of source.matchAll(/\baction:\s*'((?:auth|admin|environment|instance|security|settings)\.[a-z0-9_.]+)'/g)) written.add(match[1]!);
      for (const match of source.matchAll(/:\s*'((?:auth)\.setup_[a-z_]+)'/g)) written.add(match[1]!);
    }
    expect(written.size).toBeGreaterThan(20);
    expect([...written].filter((action) => !catalogue.has(action)).sort()).toEqual([]);
    for (const action of ['admin.server_assigned', 'admin.account_deleted', 'auth.invitation_accepted', 'auth.recovery_link_used', 'environment.token_promoted']) {
      expect(catalogue.has(action)).toBe(true);
    }
  });
});

describe.skipIf(!available)('journal multi-comptes', () => {
  let accounts: TwoAccounts;

  beforeAll(async () => {
    await prepareSuiteDatabase(SUITE);
  });

  afterAll(async () => {
    await dropSuiteDatabase(SUITE);
  });

  beforeEach(async () => {
    accounts = await resetAccounts();
  });

  async function rows() {
    const { db } = await import('@/server/db');
    return db.select().from(auditLog).orderBy(auditLog.id);
  }

  it('writes space, server, subject and the author e-mail (filled from the actor)', async () => {
    const { audit } = await import('./audit');
    const { a } = accounts;
    await audit({
      action: 'git.push',
      summary: 'push de crm-core vers origin',
      actorUserId: a.userId,
      spaceId: a.spaceId,
      environmentId: a.environmentId,
      metadata: { branch: 'main', token: 'ne-doit-pas-sortir' },
    });
    await audit({ action: 'admin.account_disabled', summary: 'compte désactivé', actorUserId: a.userId, actorLabel: 'figé@example.test', subjectUserId: accounts.b.userId });
    await audit({ action: 'auth.sign_in_failed', summary: 'échec de connexion', subjectUserId: accounts.b.userId, spaceId: 'pas-un-uuid' });
    const [push, admin, failed] = await rows();
    expect(push).toMatchObject({
      action: 'git.push',
      actorKind: 'user',
      actorLabel: 'ethan@example.test',
      spaceId: a.spaceId,
      environmentId: a.environmentId,
      subjectUserId: null,
      metadata: { branch: 'main' },
    });
    expect(admin).toMatchObject({ actorLabel: 'figé@example.test', subjectUserId: accounts.b.userId });
    // A malformed id never makes the write fail; system events have no label.
    expect(failed).toMatchObject({ actorKind: 'system', actorLabel: null, spaceId: null, subjectUserId: accounts.b.userId });
  });

  it('never throws (journal failures are logged, the action goes on)', async () => {
    const { audit } = await import('./audit');
    await expect(audit({ action: 'auth.sign_in', summary: 'connexion', actorUserId: 'compte-inconnu' })).resolves.toBeUndefined();
    // Unknown actor: the foreign key refuses the row, nothing is written, nothing thrown.
    expect(await rows()).toHaveLength(0);
  });

  it("shows each account its own journal only: never the other account's or the other space's rows", async () => {
    const { audit, listUserJournal } = await import('./audit');
    const { a, b } = accounts;
    // A's own account events, A's space events, A's business events (not in the personal journal).
    await audit({ action: 'auth.sign_in', summary: 'A connexion', actorUserId: a.userId, subjectUserId: a.userId });
    await audit({ action: 'settings.updated', summary: "A réglages de l'espace", actorUserId: a.userId, spaceId: a.spaceId, metadata: { scope: 'space' } });
    await audit({ action: 'permission.allowed', summary: 'A autorisation', actorUserId: a.userId, spaceId: a.spaceId, environmentId: a.environmentId });
    await audit({ action: 'integration.github_connected', summary: 'A GitHub', actorUserId: a.userId, spaceId: a.spaceId });
    await audit({ action: 'git.push', summary: 'A push', actorUserId: a.userId, spaceId: a.spaceId, environmentId: a.environmentId });
    await audit({ action: 'session.started', summary: 'A session', actorUserId: a.userId, spaceId: a.spaceId, environmentId: a.environmentId });
    // B's events.
    await audit({ action: 'auth.sign_in', summary: 'B connexion', actorUserId: b.userId, subjectUserId: b.userId });
    await audit({ action: 'permission.denied', summary: 'B autorisation', actorUserId: b.userId, spaceId: b.spaceId, environmentId: b.environmentId });
    await audit({ action: 'settings.updated', summary: 'B préférences', actorUserId: b.userId, subjectUserId: b.userId, metadata: { scope: 'user' } });
    // An administrator (A) acting on B, and a failed sign-in on B's e-mail.
    await audit({ action: 'admin.account_disabled', summary: 'A désactive B', actorUserId: a.userId, subjectUserId: b.userId });
    await audit({ action: 'auth.sign_in_failed', summary: 'échec sur B', subjectUserId: b.userId, metadata: { email: b.email } });
    // An instance event by A (not in A's personal journal: instance journal).
    await audit({ action: 'instance.settings_updated', summary: "A réglages d'instance", actorUserId: a.userId, metadata: { scope: 'instance' } });

    const journalA = await listUserJournal({ userId: a.userId, spaceIds: [a.spaceId] });
    expect(journalA.items.map((item) => item.summary)).toEqual(['A GitHub', 'A autorisation', "A réglages de l'espace", 'A connexion']);
    const journalB = await listUserJournal({ userId: b.userId, spaceIds: [b.spaceId] });
    expect(journalB.items.map((item) => item.summary)).toEqual(['échec sur B', 'A désactive B', 'B préférences', 'B autorisation', 'B connexion']);

    // Malformed space ids are ignored (the caller passes the context's spaces, never client input).
    const forged = await listUserJournal({ userId: b.userId, spaceIds: [b.spaceId, 'pas-un-uuid'] });
    expect(forged.items).toHaveLength(5);
    const none = await listUserJournal({ userId: '', spaceIds: [a.spaceId] });
    expect(none.items).toHaveLength(0);
  });

  it('pages the personal journal with a cursor', async () => {
    const { audit, listUserJournal } = await import('./audit');
    const { a } = accounts;
    for (let index = 0; index < 5; index += 1) {
      await audit({ action: 'auth.sign_in', summary: `connexion ${index}`, actorUserId: a.userId });
    }
    const first = await listUserJournal({ userId: a.userId, spaceIds: [a.spaceId], limit: 2 });
    expect(first.items.map((item) => item.summary)).toEqual(['connexion 4', 'connexion 3']);
    expect(first.nextCursor).not.toBeNull();
    const second = await listUserJournal({ userId: a.userId, spaceIds: [a.spaceId], limit: 2, before: first.nextCursor! });
    expect(second.items.map((item) => item.summary)).toEqual(['connexion 2', 'connexion 1']);
    const last = await listUserJournal({ userId: a.userId, spaceIds: [a.spaceId], limit: 2, before: second.nextCursor! });
    expect(last.items.map((item) => item.summary)).toEqual(['connexion 0']);
    expect(last.nextCursor).toBeNull();
    // A malformed page size or cursor falls back to the defaults instead of failing the query.
    const lenient = await listUserJournal({ userId: a.userId, spaceIds: [a.spaceId], limit: Number.NaN, before: Number.NaN });
    expect(lenient.items).toHaveLength(5);
  });

  it('instance journal: account and instance events of every account, never business events', async () => {
    const { audit, listInstanceJournal } = await import('./audit');
    const { a, b } = accounts;
    await audit({ action: 'auth.sign_in', summary: 'B connexion', actorUserId: b.userId, subjectUserId: b.userId, ip: '203.0.113.7' });
    await audit({ action: 'admin.invitation_created', summary: 'invitation', actorUserId: a.userId });
    await audit({ action: 'environment.registered', summary: 'serveur « VPS-4 » enregistré', actorUserId: a.userId, environmentId: b.environmentId });
    await audit({ action: 'instance.settings_updated', summary: "réglages d'instance", actorUserId: a.userId });
    await audit({ action: 'security.runner_scope_violation', summary: 'portée refusée', actorKind: 'runner', environmentId: b.environmentId });
    for (const action of ['git.push', 'project.created', 'session.started', 'terminal.opened', 'permission.allowed', 'integration.coolify_connected']) {
      await audit({ action, summary: `métier ${action}`, actorUserId: b.userId, spaceId: b.spaceId, environmentId: b.environmentId });
    }
    const all = await listInstanceJournal();
    expect(all.items.map((item) => item.action)).toEqual([
      'security.runner_scope_violation',
      'instance.settings_updated',
      'environment.registered',
      'admin.invitation_created',
      'auth.sign_in',
    ]);
    expect(all.items.at(-1)).toMatchObject({ ip: '203.0.113.7', actorLabel: 'camille@example.test' });

    const aboutB = await listInstanceJournal({ userId: b.userId });
    expect(aboutB.items.map((item) => item.summary)).toEqual(['B connexion']);
  });
});
