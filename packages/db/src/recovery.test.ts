import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runRecoveryLinkCli } from './cli/recovery-command';
import { createDb, type Database } from './index';
import { runMigrations } from './migrate';
import { createRecoveryLink, recoveryLinkUrl, RecoveryLinkError } from './recovery';
import { seedMember, seedOwner, type SeededAccount } from './test/fixtures';
import { adminClient, databaseUrl, dropDatabase, pgAvailable, pgFailure, recreateDatabase, testName } from './test/pg';
import { generateLinkToken, sha256Hex } from './tokens';

/**
 * Break-glass recovery link (docs/MULTICOMPTE.md §6): closes web accesses, trusted devices and the
 * second factor of the account, revokes its previous links, stores only the sha256 of the token,
 * journals the action and prints the link once.
 */

const DB_NAME = testName('recovery');
const available = await pgAvailable('recovery.test');
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

describe('jetons et adresse du lien', () => {
  it('jeton base64url de 32 octets, empreinte sha256 hexadécimale', () => {
    const token = generateLinkToken();
    expect(token).toMatch(TOKEN);
    expect(generateLinkToken()).not.toBe(token);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('construit /recuperation/<jeton> en gardant un éventuel chemin de base', () => {
    expect(recoveryLinkUrl('https://dev.nuera.studio', 'abc')).toBe('https://dev.nuera.studio/recuperation/abc');
    expect(recoveryLinkUrl('https://dev.nuera.studio/', 'abc')).toBe('https://dev.nuera.studio/recuperation/abc');
    expect(recoveryLinkUrl('https://exemple.test/nuera?x=1#y', 'abc')).toBe('https://exemple.test/nuera/recuperation/abc');
    expect(() => recoveryLinkUrl('ftp://exemple.test', 'abc')).toThrow(RecoveryLinkError);
    expect(() => recoveryLinkUrl('pas une adresse', 'abc')).toThrow(/Adresse de Nuera Dev invalide/);
  });
});

describe.skipIf(!available)('lien de récupération en ligne de commande', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let db: Database;
  let owner: SeededAccount;
  let other: SeededAccount;
  const url = databaseUrl(DB_NAME);
  const future = new Date(Date.now() + 30 * 86_400_000);

  beforeAll(async () => {
    admin = adminClient();
    await recreateDatabase(admin, DB_NAME);
    await runMigrations(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    db = createDb(url, { max: 2 });
    owner = await seedOwner(db, { email: 'ethan@example.test', name: 'Ethan' });
    other = await seedMember(db, { email: 'camille@example.test', name: 'Camille', environment: false });
  });

  beforeEach(async () => {
    await sql`delete from invitations`;
    await sql`delete from audit_log`;
    await sql`delete from two_factor`;
    await sql`delete from session`;
    await sql`delete from verification`;
    await sql`delete from passkey`;
    await sql`update "user" set two_factor_enabled = true, disabled_at = null`;
    for (const account of [owner, other]) {
      await sql`insert into two_factor (id, secret, backup_codes, user_id) values (${`tf-${account.userId}`}, 's', 'c', ${account.userId})`;
      await sql`insert into session (id, expires_at, token, user_id) values
                  (${`s1-${account.userId}`}, ${future}, ${`t1-${account.userId}`}, ${account.userId}),
                  (${`s2-${account.userId}`}, ${future}, ${`t2-${account.userId}`}, ${account.userId})`;
      await sql`insert into verification (id, identifier, value, expires_at) values
                  (${`v1-${account.userId}`}, ${`trust-device-${account.userId}`}, ${account.userId}, ${future}),
                  (${`v2-${account.userId}`}, ${`2fa-${account.userId}`}, ${account.userId}, ${future})`;
      await sql`insert into passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
                values (${`pk-${account.userId}`}, 'cle', ${account.userId}, ${`cred-${account.userId}`}, 0, 'singleDevice', false)`;
    }
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await db?.$client.end({ timeout: 5 });
    if (admin) {
      await dropDatabase(admin, DB_NAME);
      await admin.end({ timeout: 5 });
    }
  });

  it("ferme les accès du compte, oublie sa 2FA et ses appareils de confiance, et crée un lien à usage unique", async () => {
    await sql`insert into invitations (kind, email, role, user_id, token_hash, expires_at)
              values ('recovery', 'ethan@example.test', 'owner', ${owner.userId}, 'ancien', ${future})`;
    await sql`insert into invitations (kind, email, token_hash, expires_at) values ('invite', 'nouveau@example.test', 'invitation', ${future})`;
    const now = new Date('2026-11-05T10:00:00Z');
    const link = await createRecoveryLink(db, { email: '  ETHAN@example.test ', appUrl: 'https://dev.nuera.studio', now });

    expect(link.token).toMatch(TOKEN);
    expect(link.url).toBe(`https://dev.nuera.studio/recuperation/${link.token}`);
    expect(link).toMatchObject({ userId: owner.userId, email: 'ethan@example.test', closedSessions: 2, removedTrustedDevices: 1, removedPasskeys: 0 });
    // Passkeys stay unless the device holding them is declared lost.
    expect(await sql`select count(*)::int as count from passkey`).toEqual([{ count: 2 }]);
    expect(link.expiresAt.toISOString()).toBe('2026-11-06T10:00:00.000Z');

    expect(await sql`select user_id from two_factor`).toEqual([{ user_id: other.userId }]);
    expect(await sql`select id, two_factor_enabled from "user" order by id`).toEqual(
      [
        { id: owner.userId, two_factor_enabled: false },
        { id: other.userId, two_factor_enabled: true },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect((await sql`select user_id from session`).map((row) => row.user_id)).toEqual([other.userId, other.userId]);
    expect((await sql<{ identifier: string }[]>`select identifier from verification order by identifier`).map((row) => row.identifier)).toEqual(
      [`2fa-${other.userId}`, `2fa-${owner.userId}`, `trust-device-${other.userId}`].sort(),
    );
    const invitations = await sql`
      select kind, email, role, user_id, token_hash, expires_at, created_by_user_id, revoked_at is not null as revoked
      from invitations order by created_at, token_hash`;
    expect(invitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token_hash: 'ancien', revoked: true }),
        expect.objectContaining({ token_hash: 'invitation', revoked: false }),
        {
          kind: 'recovery',
          email: 'ethan@example.test',
          role: 'owner',
          user_id: owner.userId,
          token_hash: sha256Hex(link.token),
          expires_at: new Date('2026-11-06T10:00:00Z'),
          created_by_user_id: null,
          revoked: false,
        },
      ]),
    );
    expect(JSON.stringify(invitations)).not.toContain(link.token);
    expect(await sql`select actor_user_id, actor_kind, action, target_type, target_id, subject_user_id, space_id from audit_log`).toEqual([
      {
        actor_user_id: null,
        actor_kind: 'system',
        action: 'admin.recovery_link_cli',
        target_type: 'user',
        target_id: owner.userId,
        subject_user_id: owner.userId,
        space_id: null,
      },
    ]);
  });

  it("peut servir à une action d'administrateur (auteur journalisé)", async () => {
    const link = await createRecoveryLink(db, {
      email: 'camille@example.test',
      appUrl: 'https://dev.nuera.studio',
      actor: { userId: owner.userId, label: 'ethan@example.test' },
    });
    const [invitation] = await sql`select role, created_by_user_id from invitations where token_hash = ${sha256Hex(link.token)}`;
    expect(invitation).toEqual({ role: 'member', created_by_user_id: owner.userId });
    expect(await sql`select actor_user_id, actor_kind, actor_label, action, subject_user_id from audit_log`).toEqual([
      { actor_user_id: owner.userId, actor_kind: 'user', actor_label: 'ethan@example.test', action: 'admin.recovery_link_created', subject_user_id: other.userId },
    ]);
  });

  it('refuse une adresse inconnue, un compte désactivé ou supprimé, sans rien modifier', async () => {
    expect(await pgFailure(createRecoveryLink(db, { email: 'inconnu@example.test', appUrl: 'https://x.test' }))).toMatch(
      /Aucun compte ne correspond à l'adresse inconnu@example\.test\./,
    );
    await sql`update "user" set disabled_at = now() where id = ${other.userId}`;
    await expect(createRecoveryLink(db, { email: 'camille@example.test', appUrl: 'https://x.test' })).rejects.toMatchObject({
      code: 'ACCOUNT_DISABLED',
    });
    await sql`update "user" set disabled_at = now(), deleted_at = now() where id = ${other.userId}`;
    await expect(createRecoveryLink(db, { email: 'camille@example.test', appUrl: 'https://x.test' })).rejects.toMatchObject({
      code: 'ACCOUNT_DELETED',
    });
    await sql`update "user" set deleted_at = null where id = ${other.userId}`;
    expect(await sql`select count(*)::int as count from two_factor`).toEqual([{ count: 2 }]);
    expect(await sql`select count(*)::int as count from invitations`).toEqual([{ count: 0 }]);
    expect(await sql`select count(*)::int as count from audit_log`).toEqual([{ count: 0 }]);
  });

  it("supprime aussi les clés d'accès quand l'appareil est perdu", async () => {
    const out: string[] = [];
    const io = { env: { DATABASE_URL: url, APP_URL: 'https://dev.nuera.studio' }, out: (l: string) => out.push(l), err: () => {} };
    expect(await runRecoveryLinkCli(['--email', 'ethan@example.test', '--remove-passkeys'], io)).toBe(0);
    expect(out).toHaveLength(1);
    expect(await sql`select user_id from passkey`).toEqual([{ user_id: other.userId }]);
    expect(await sql`select user_id from two_factor`).toEqual([{ user_id: other.userId }]);
    const [audit] = await sql`
      select metadata ->> 'removedPasskeys' as passkeys, metadata ->> 'closedSessions' as sessions,
             metadata ->> 'removedTrustedDevices' as devices
      from audit_log`;
    expect(audit).toEqual({ passkeys: '1', sessions: '2', devices: '1' });
  });

  it("la commande affiche le lien une seule fois, et rien d'autre, valable 24 h", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { env: { DATABASE_URL: url, APP_URL: 'https://dev.nuera.studio' }, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    expect(await runRecoveryLinkCli(['--', '--email', 'ethan@example.test'], io)).toBe(0);
    expect(err).toEqual([]);
    // Only the link line: no e-mail, no count, no other copy of the token.
    expect(out).toHaveLength(1);
    const match = /^Lien de récupération \(valable 24 h, à usage unique\) : https:\/\/dev\.nuera\.studio\/recuperation\/([A-Za-z0-9_-]{43})$/.exec(
      out[0] ?? '',
    );
    expect(match).not.toBeNull();
    const [row] = await sql`select count(*)::int as count from invitations where token_hash = ${sha256Hex(match![1]!)} and revoked_at is null`;
    expect(row).toEqual({ count: 1 });
    expect(JSON.stringify(await sql`select * from audit_log`)).not.toContain(match![1]!);

    out.length = 0;
    expect(await runRecoveryLinkCli(['--email', 'ethan@example.test', '--app-url', 'https://autre.test'], io)).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/: https:\/\/autre\.test\/recuperation\/[A-Za-z0-9_-]{43}$/);
    // The previous link is revoked.
    const [previous] = await sql`select revoked_at is not null as revoked from invitations where token_hash = ${sha256Hex(match![1]!)}`;
    expect(previous).toEqual({ revoked: true });
  });

  it('révoque aussi un ancien lien jamais accepté, quelles que soient ses autres dates', async () => {
    // Inconsistent leftover (completed without accepted): it still holds invitations_pending_email_idx.
    await sql`insert into invitations (kind, email, role, user_id, token_hash, expires_at, completed_at)
              values ('recovery', 'camille@example.test', 'member', ${other.userId}, 'reste', ${future}, now())`;
    // Finished recovery (accepted and completed): kept as is.
    await sql`insert into invitations (kind, email, role, user_id, token_hash, expires_at, accepted_at, completed_at)
              values ('recovery', 'camille@example.test', 'member', ${other.userId}, 'terminee', ${future}, now(), now())`;
    const link = await createRecoveryLink(db, { email: 'camille@example.test', appUrl: 'https://dev.nuera.studio' });
    const byHash = (a: { token_hash: string }, b: { token_hash: string }) => (a.token_hash < b.token_hash ? -1 : 1);
    const rows = await sql<{ token_hash: string; revoked: boolean }[]>`select token_hash, revoked_at is not null as revoked from invitations`;
    expect([...rows].sort(byHash)).toEqual(
      [
        { token_hash: 'reste', revoked: true },
        { token_hash: 'terminee', revoked: false },
        { token_hash: sha256Hex(link.token), revoked: false },
      ].sort(byHash),
    );
  });

  it('la commande refuse proprement une saisie incomplète', async () => {
    const err: string[] = [];
    const io = (env: Record<string, string | undefined>) => ({ env, out: () => {}, err: (l: string) => err.push(l) });
    expect(await runRecoveryLinkCli([], io({ DATABASE_URL: url, APP_URL: 'https://x.test' }))).toBe(2);
    expect(err[0]).toBe('Adresse e-mail manquante (--email).');
    err.length = 0;
    expect(await runRecoveryLinkCli(['--email', 'ethan@example.test'], io({ DATABASE_URL: url }))).toBe(2);
    expect(err[0]).toBe('Adresse de Nuera Dev manquante : passez --app-url ou définissez APP_URL.');
    err.length = 0;
    expect(await runRecoveryLinkCli(['--email', 'ethan@example.test'], io({ APP_URL: 'https://x.test' }))).toBe(2);
    expect(err[0]).toMatch(/^DATABASE_URL manquant/);
    err.length = 0;
    expect(await runRecoveryLinkCli(['--courriel', 'x'], io({ DATABASE_URL: url, APP_URL: 'https://x.test' }))).toBe(2);
    err.length = 0;
    expect(await runRecoveryLinkCli(['--email', 'personne@example.test'], io({ DATABASE_URL: url, APP_URL: 'https://x.test' }))).toBe(1);
    expect(err).toEqual(["Aucun compte ne correspond à l'adresse personne@example.test."]);
  });
});
