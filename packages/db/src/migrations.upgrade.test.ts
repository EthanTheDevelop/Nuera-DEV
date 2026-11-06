import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './index';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate';
import { seedMember, seedOwner } from './test/fixtures';
import { adminClient, dropDatabase, pgAvailable, recreateDatabase, testName } from './test/pg';

/**
 * Upgrade of an existing installation: a database at 0000 (single owner, the state deployed in
 * production) filled like production, then migrated to the latest version. Every row must be kept
 * and attached to the owner's space and to the default server (docs/MULTICOMPTE.md §3.3). Edge
 * cases: no account yet, no app_settings row, several accounts, data without any account.
 */

const available = await pgAvailable('migrations.upgrade.test');

const DATABASES = {
  full: testName('upgrade_full'),
  noUser: testName('upgrade_no_user'),
  noSettings: testName('upgrade_no_settings'),
  severalUsers: testName('upgrade_several_users'),
  orphans: testName('upgrade_orphans'),
  runnerScope: testName('upgrade_runner_scope'),
};

const OWNER = 'owner-0000';
const ID = {
  github: '6f1c0b39-0000-4000-8000-000000000001',
  coolify: '6f1c0b39-0000-4000-8000-000000000002',
  mcpFigma: '6f1c0b39-0000-4000-8000-000000000003',
  mcpDocs: '6f1c0b39-0000-4000-8000-000000000004',
  project: '6f1c0b39-0000-4000-8000-000000000005',
  projectArchived: '6f1c0b39-0000-4000-8000-000000000006',
  worktree: '6f1c0b39-0000-4000-8000-000000000007',
  worktreeRemoved: '6f1c0b39-0000-4000-8000-000000000008',
  session: '6f1c0b39-0000-4000-8000-000000000009',
  sessionDone: '6f1c0b39-0000-4000-8000-00000000000a',
  permission: '6f1c0b39-0000-4000-8000-00000000000b',
  run: '6f1c0b39-0000-4000-8000-00000000000c',
  operation: '6f1c0b39-0000-4000-8000-00000000000d',
  operationWithoutProject: '6f1c0b39-0000-4000-8000-00000000000e',
  pullRequest: '6f1c0b39-0000-4000-8000-00000000000f',
  envVar: '6f1c0b39-0000-4000-8000-000000000010',
  notifRead: '6f1c0b39-0000-4000-8000-000000000011',
  notifOld: '6f1c0b39-0000-4000-8000-000000000012',
  notifNew: '6f1c0b39-0000-4000-8000-000000000013',
  notifError: '6f1c0b39-0000-4000-8000-000000000014',
  notifPlain: '6f1c0b39-0000-4000-8000-000000000015',
  notifPermission: '6f1c0b39-0000-4000-8000-000000000016',
  notifCoolify: '6f1c0b39-0000-4000-8000-000000000017',
  push: '6f1c0b39-0000-4000-8000-000000000018',
  notifClaudeOld: '6f1c0b39-0000-4000-8000-000000000019',
  notifClaudeNew: '6f1c0b39-0000-4000-8000-00000000001a',
  notifMcp: '6f1c0b39-0000-4000-8000-00000000001b',
};

const GITHUB_CONFIG = {
  mode: 'app',
  appId: 42,
  slug: 'nuera-dev',
  clientId: 'Iv1.0123456789abcdef',
  name: 'Nuera Dev (Ethan)',
  htmlUrl: 'https://github.com/apps/nuera-dev',
  owner: { login: 'nuera-studio', id: 7, type: 'Organization' },
  public: false,
  allowedAccountIds: [7],
  installations: [
    {
      id: 99,
      accountId: 7,
      accountLogin: 'nuera-studio',
      accountType: 'Organization',
      repositorySelection: 'selected',
      permissions: { contents: 'write', pull_requests: 'write' },
      suspendedAt: null,
    },
  ],
  consecutiveFailures: 0,
};

/** Tables whose rows must all survive the upgrade unchanged in number. */
const KEPT_TABLES = [
  'user',
  'session',
  'account',
  'verification',
  'two_factor',
  'projects',
  'project_env_vars',
  'project_mcp_servers',
  'mcp_servers',
  'worktrees',
  'sessions',
  'session_events',
  'permission_requests',
  'operations',
  'command_runs',
  'pull_requests',
  'notifications',
  'push_subscriptions',
  'audit_log',
  'uptime_daily',
];

async function countRows(sql: postgres.Sql, tables: string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await sql.unsafe<{ count: string }[]>(`select count(*) from "${table}"`);
    result[table] = Number(row?.count ?? 0);
  }
  return result;
}

/** The production installation: one owner and something in every table. */
async function seedLegacyInstallation(sql: postgres.Sql): Promise<void> {
  const future = new Date('2027-01-01T00:00:00Z');
  await sql`insert into "user" (id, name, email, email_verified, two_factor_enabled, created_at)
            values (${OWNER}, 'Ethan Ngo', 'ethan@example.test', true, true, '2026-10-01T08:00:00Z')`;
  await sql`insert into account (id, account_id, provider_id, user_id, password) values ('acc-1', ${OWNER}, 'credential', ${OWNER}, 'scrypt$hash')`;
  await sql`insert into session (id, expires_at, token, user_id) values ('sess-1', ${future}, 'tok-1', ${OWNER})`;
  await sql`insert into two_factor (id, secret, backup_codes, user_id) values ('tf-1', 'enc-secret', 'enc-codes', ${OWNER})`;
  await sql`insert into verification (id, identifier, value, expires_at) values ('ver-1', 'trust-device-abc', ${OWNER}, ${future})`;
  await sql`insert into app_settings (id, max_concurrent_sessions, default_model, default_effort, default_permission_mode,
              block_bypass_permissions, permission_wait_seconds, remote_control_by_default, web_session_idle_hours,
              web_session_max_days, projects_root, server_name, server_location, session_memory_limit_mb,
              worktree_stale_days, theme, locale)
            values (1, 6, 'opus', 'high', 'acceptEdits', false, 300, true, 8, 20, '/srv/dev', 'VPS-9', 'Gravelines', 2048, 14, 'dark', 'fr')`;
  await sql`insert into integrations (id, kind, status, config, secrets_encrypted, last_checked_at, last_success_at, created_at, updated_at)
            values (${ID.github}, 'github', 'connected', ${sql.json(GITHUB_CONFIG)}, 'v1:secret-github',
                    '2026-11-04T10:00:00Z', '2026-11-04T10:00:00Z', '2026-10-02T09:00:00Z', '2026-11-04T10:00:00Z')`;
  await sql`insert into integrations (id, kind, status, label, config, secrets_encrypted)
            values (${ID.coolify}, 'coolify', 'connected', 'Coolify', ${sql.json({ baseUrl: 'https://coolify.example.test' })}, 'v1:secret-coolify')`;
  await sql`insert into mcp_servers (id, name, label, transport, url, config)
            values (${ID.mcpFigma}, 'figma', 'Figma', 'http', 'https://mcp.figma.com/mcp', ${sql.json({ presetId: 'figma' })})`;
  await sql`insert into mcp_servers (id, name, label, transport, command, args)
            values (${ID.mcpDocs}, 'docs', 'Documentation', 'stdio', 'npx', ${sql.json(['docs-mcp'])})`;
  await sql`insert into projects (id, slug, name, github_full_name, github_installation_id, clone_url, path, status, is_favorite)
            values (${ID.project}, 'nuera-os', 'Nuera OS', 'nuera-studio/nuera-os', 99,
                    'https://github.com/nuera-studio/nuera-os.git', '/srv/dev/nuera-os', 'ready', true)`;
  await sql`insert into projects (id, slug, name, github_full_name, clone_url, path, status, archived_at)
            values (${ID.projectArchived}, 'nuera-os-ancien', 'Nuera OS (ancien)', 'nuera-studio/nuera-os',
                    'https://github.com/nuera-studio/nuera-os.git', '/srv/dev/nuera-os-ancien', 'archived', '2026-10-15T12:00:00Z')`;
  await sql`insert into project_mcp_servers (project_id, mcp_server_id) values (${ID.project}, ${ID.mcpFigma})`;
  await sql`insert into project_env_vars (id, project_id, key, value_encrypted) values (${ID.envVar}, ${ID.project}, 'API_URL', 'v1:value')`;
  await sql`insert into worktrees (id, project_id, name, branch, path, is_primary)
            values (${ID.worktree}, ${ID.project}, 'nuera-os', 'main', '/srv/dev/nuera-os', true)`;
  await sql`insert into worktrees (id, project_id, name, branch, path, status, removed_at)
            values (${ID.worktreeRemoved}, ${ID.project}, 'crm', 'crm', '/srv/dev/.worktrees/nuera-os/crm', 'removed', '2026-10-20T10:00:00Z')`;
  await sql`insert into sessions (id, project_id, worktree_id, title, status, tmux_name, created_by_user_id)
            values (${ID.session}, ${ID.project}, ${ID.worktree}, 'CRM', 'running', 'nuera-nuera-os-crm', ${OWNER})`;
  await sql`insert into sessions (id, project_id, title, status, created_by_user_id)
            values (${ID.sessionDone}, ${ID.project}, 'Docs', 'finished', ${OWNER})`;
  await sql`insert into session_events (session_id, position, version, kind, payload)
            values (${ID.session}, 1, 1, 'instruction', ${sql.json({ text: 'Ajoute les tests', source: 'nuera', at: '2026-11-04T10:00:00Z' })}),
                   (${ID.session}, 2, 2, 'system', ${sql.json({ message: 'ok', at: '2026-11-04T10:00:01Z' })})`;
  await sql`insert into permission_requests (id, session_id, tool_name, tool_input, title, status)
            values (${ID.permission}, ${ID.session}, 'Bash', ${sql.json({ command: 'npm test' })}, 'Claude demande à exécuter une commande', 'pending')`;
  await sql`insert into command_runs (id, project_id, worktree_id, kind, command, status)
            values (${ID.run}, ${ID.project}, ${ID.worktree}, 'test', 'npm test', 'succeeded')`;
  await sql`insert into operations (id, kind, status, project_id, actor_user_id) values (${ID.operation}, 'pull', 'succeeded', ${ID.project}, ${OWNER})`;
  await sql`insert into operations (id, kind, status) values (${ID.operationWithoutProject}, 'maintenance', 'running')`;
  await sql`insert into pull_requests (id, project_id, session_id, number, title, head_branch, base_branch, url)
            values (${ID.pullRequest}, ${ID.project}, ${ID.session}, 12, 'feat: CRM', 'crm', 'main', 'https://github.com/nuera-studio/nuera-os/pull/12')`;
  await sql`insert into notifications (id, kind, title, dedup_key, read_at, created_at)
            values (${ID.notifRead}, 'session_finished', 'Session terminée', 'session:x:turn:1', '2026-11-03T08:00:00Z', '2026-11-03T07:00:00Z')`;
  await sql`insert into notifications (id, kind, severity, title, dedup_key, created_at)
            values (${ID.notifOld}, 'integration_expired', 'danger', 'Accès GitHub retiré', 'integration:github:expired', '2026-11-01T08:00:00Z'),
                   (${ID.notifNew}, 'integration_expired', 'danger', 'Accès GitHub retiré', 'integration:github:expired', '2026-11-02T08:00:00Z'),
                   (${ID.notifError}, 'integration_error', 'danger', 'GitHub ne répond plus', 'integration:github:error', '2026-11-02T09:00:00Z'),
                   (${ID.notifCoolify}, 'integration_expiring', 'warning', 'Coolify bientôt expiré', 'integration:coolify:expiring', '2026-11-02T09:30:00Z')`;
  await sql`insert into notifications (id, kind, severity, title, dedup_key, created_at)
            values (${ID.notifClaudeOld}, 'claude_disconnected', 'danger', 'Claude Code est déconnecté', 'claude:auth', '2026-11-02T06:00:00Z'),
                   (${ID.notifClaudeNew}, 'claude_disconnected', 'danger', 'Claude Code est déconnecté', 'claude:auth', '2026-11-02T07:00:00Z'),
                   (${ID.notifMcp}, 'integration_error', 'danger', 'Figma ne répond plus', 'integration:mcp:figma:error', '2026-11-02T09:45:00Z')`;
  await sql`insert into notifications (id, kind, title, created_at) values (${ID.notifPlain}, 'server', 'Serveur redémarré', '2026-11-02T10:00:00Z')`;
  await sql`insert into notifications (id, kind, title, project_id, session_id, dedup_key)
            values (${ID.notifPermission}, 'permission_request', 'Autorisation demandée', ${ID.project}, ${ID.session}, ${`permission:${ID.permission}`})`;
  await sql`insert into push_subscriptions (id, user_id, endpoint, p256dh, auth)
            values (${ID.push}, ${OWNER}, 'https://push.example.test/abc', 'p256', 'auth')`;
  await sql`insert into audit_log (actor_user_id, actor_kind, action, summary, metadata) values
              (${OWNER}, 'user', 'auth.sign_in', 'connexion', null),
              (null, 'system', 'auth.sign_in_failed', 'échec de connexion', ${sql.json({ method: 'password', email: 'ETHAN@example.test' })}),
              (null, 'system', 'auth.sign_in_failed', 'échec de connexion', ${sql.json({ method: 'password', email: 'inconnu@example.test' })}),
              (${OWNER}, 'user', 'git.push', 'push de crm', null),
              (null, 'runner', 'integration.github.write_token_issued', 'jeton d''écriture', null),
              (${OWNER}, 'user', 'settings.updated', 'réglages', null),
              (${OWNER}, 'user', 'security.push_subscribed', 'notifications activées', null),
              (${OWNER}, 'user', 'integration.coolify.connected', 'Coolify connecté', null),
              (${OWNER}, 'user', 'project.created', 'projet créé', null),
              (${OWNER}, 'user', 'session.create', 'session créée', null),
              (${OWNER}, 'user', 'terminal.open', 'terminal ouvert', null),
              (${OWNER}, 'user', 'permission.decision', 'autorisation accordée', null),
              (null, 'system', 'maintenance.auto', 'maintenance automatique', null),
              (null, 'system', 'auth.sign_in_failed', 'échec de connexion', ${sql.json(['pas', 'un objet'])})`;
  await sql`insert into uptime_daily (day, service, up_minutes, expected_minutes, last_beat_at) values
              ('2026-11-01', 'runner', 1440, 1440, '2026-11-01T22:59:00Z'),
              ('2026-11-02', 'runner', 600, 700, '2026-11-02T11:40:00Z'),
              ('2026-11-01', 'web', 1440, 1440, null)`;
}

describe.skipIf(!available)('montée de version 0000 → dernière migration', () => {
  let admin: postgres.Sql;
  let legacyFolder: string;
  const clients: postgres.Sql[] = [];

  /** Database at 0000 only (the version deployed before the multi-account model). */
  async function legacyDatabase(name: string): Promise<{ url: string; sql: postgres.Sql }> {
    const url = await recreateDatabase(admin, name);
    await runMigrations(url, legacyFolder);
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    clients.push(sql);
    return { url, sql };
  }

  beforeAll(async () => {
    admin = adminClient();
    legacyFolder = mkdtempSync(path.join(tmpdir(), 'nuera-0000-'));
    mkdirSync(path.join(legacyFolder, 'meta'));
    copyFileSync(path.join(MIGRATIONS_FOLDER, '0000_material_hiroim.sql'), path.join(legacyFolder, '0000_material_hiroim.sql'));
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] };
    writeFileSync(path.join(legacyFolder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
  });

  afterAll(async () => {
    for (const client of clients) await client.end({ timeout: 5 }).catch(() => {});
    if (admin) {
      for (const name of Object.values(DATABASES)) await dropDatabase(admin, name);
      await admin.end({ timeout: 5 });
    }
    if (legacyFolder) rmSync(legacyFolder, { recursive: true, force: true });
  });

  it("0005 : une référence à un worktree ou à une session d'un autre serveur est effacée, les autres restent", async () => {
    // Database at 0004 (the multi-account model before the composite keys of 0005).
    const folder = mkdtempSync(path.join(tmpdir(), 'nuera-0004-'));
    try {
      mkdirSync(path.join(folder, 'meta'));
      const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
      const entries = journal.entries.slice(0, journal.entries.findIndex((entry) => entry.tag === '0004_runner_roles') + 1);
      expect(entries).toHaveLength(5);
      for (const entry of entries) copyFileSync(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
      writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
      const url = await recreateDatabase(admin, DATABASES.runnerScope);
      await runMigrations(url, folder);
      const db = createDb(url, { max: 1 });
      const sql = postgres(url, { max: 1, onnotice: () => {} });
      clients.push(sql);
      try {
        const owner = await seedOwner(db, { email: 'owner@example.test' });
        const member = await seedMember(db, { email: 'membre@example.test', environment: { name: 'Serveur B' } });
        const [envA, envB] = [owner.environmentId!, member.environmentId!];
        const [projectA, projectB, worktreeA, worktreeB, sessionA, sessionB, sessionLinked] = [ID.project, ID.projectArchived, ID.worktree, ID.worktreeRemoved, ID.session, ID.sessionDone, ID.permission];
        for (const [project, space, env] of [[projectA, owner.spaceId, envA], [projectB, member.spaceId, envB]] as const) {
          await sql`insert into projects (id, space_id, environment_id, slug, name, github_full_name, clone_url, path)
                    values (${project}, ${space}, ${env}, 'site', 'Site', 'x/site', 'https://github.com/x/site.git', '/srv/dev/site')`;
        }
        await sql`insert into worktrees (id, project_id, environment_id, name, branch, path) values
                    (${worktreeA}, ${projectA}, ${envA}, 'site', 'main', '/srv/dev/site'),
                    (${worktreeB}, ${projectB}, ${envB}, 'site', 'main', '/srv/dev/site')`;
        await sql`insert into sessions (id, project_id, environment_id, worktree_id, title) values
                    (${sessionA}, ${projectA}, ${envA}, ${worktreeA}, 'A'),
                    (${sessionB}, ${projectB}, ${envB}, ${worktreeA}, 'B, worktree de A'),
                    (${sessionLinked}, ${projectB}, ${envB}, ${worktreeB}, 'B')`;
        await sql`insert into command_runs (id, project_id, environment_id, worktree_id, kind, command) values
                    (${ID.run}, ${projectB}, ${envB}, ${worktreeA}, 'test', 'npm test')`;
        await sql`insert into operations (id, kind, project_id, environment_id, worktree_id, session_id) values
                    (${ID.operation}, 'pull', ${projectB}, ${envB}, ${worktreeA}, ${sessionA}),
                    (${ID.operationWithoutProject}, 'maintenance', null, ${envB}, ${worktreeB}, ${sessionLinked})`;

        await runMigrations(url);

        expect(await sql`select id, worktree_id from sessions order by id`).toEqual([
          { id: sessionA, worktree_id: worktreeA },
          { id: sessionB, worktree_id: null },
          { id: sessionLinked, worktree_id: worktreeB },
        ]);
        expect(await sql`select worktree_id, environment_id from command_runs`).toEqual([{ worktree_id: null, environment_id: envB }]);
        expect(await sql`select id, worktree_id, session_id from operations order by id`).toEqual([
          { id: ID.operation, worktree_id: null, session_id: null },
          { id: ID.operationWithoutProject, worktree_id: worktreeB, session_id: sessionLinked },
        ]);
        await expect(sql`update sessions set worktree_id = ${worktreeA} where id = ${sessionB}`).rejects.toThrow(/sessions_worktree_env_fk/);
      } finally {
        await db.$client.end({ timeout: 5 });
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  describe('installation en service (un propriétaire, des données partout)', () => {
    let sql: postgres.Sql;
    let url: string;
    let before: Record<string, number>;
    let spaceId: string;
    let environmentId: string;
    let legacyMigrations: string | undefined;

    beforeAll(async () => {
      ({ sql, url } = await legacyDatabase(DATABASES.full));
      await seedLegacyInstallation(sql);
      const [legacy] = await sql<{ count: string }[]>`select count(*) from drizzle.__drizzle_migrations`;
      legacyMigrations = legacy?.count;
      before = await countRows(sql, KEPT_TABLES);
      await runMigrations(url);
      const [space] = await sql<{ id: string }[]>`select id from spaces`;
      const [environment] = await sql<{ id: string }[]>`select id from environments where is_default`;
      spaceId = space!.id;
      environmentId = environment!.id;
    });

    it("part bien d'une base où seule 0000 est appliquée", () => {
      expect(legacyMigrations).toBe('1');
    });

    it('ne perd aucune ligne', async () => {
      expect(await countRows(sql, KEPT_TABLES)).toEqual(before);
    });

    it('le compte devient le propriétaire, avec son espace personnel', async () => {
      expect(await sql`select id, role, disabled_at, deleted_at, two_factor_enabled from "user"`).toEqual([
        { id: OWNER, role: 'owner', disabled_at: null, deleted_at: null, two_factor_enabled: true },
      ]);
      expect(await sql`select name, kind, owner_user_id, archived_at from spaces`).toEqual([
        { name: "Espace d'Ethan", kind: 'personal', owner_user_id: OWNER, archived_at: null },
      ]);
      expect(await sql`select space_id, user_id, role from space_members`).toEqual([{ space_id: spaceId, user_id: OWNER, role: 'owner' }]);
    });

    it("les réglages sont répartis entre l'espace, le compte, le serveur et l'instance", async () => {
      expect(
        await sql`select space_id, default_model, default_effort, default_permission_mode, block_bypass_permissions,
                         permission_wait_seconds, remote_control_by_default, worktree_stale_days from space_settings`,
      ).toEqual([
        {
          space_id: spaceId,
          default_model: 'opus',
          default_effort: 'high',
          default_permission_mode: 'acceptEdits',
          block_bypass_permissions: false,
          permission_wait_seconds: 300,
          remote_control_by_default: true,
          worktree_stale_days: 14,
        },
      ]);
      expect(await sql`select user_id, theme, locale, git_author_name, git_author_email from user_preferences`).toEqual([
        { user_id: OWNER, theme: 'dark', locale: 'fr', git_author_name: null, git_author_email: null },
      ]);
      const [instance] = await sql`
        select web_session_idle_hours, web_session_max_days, invitation_ttl_hours, force_block_bypass_permissions, server_name
        from app_settings`;
      expect(instance).toEqual({
        web_session_idle_hours: 8,
        web_session_max_days: 20,
        invitation_ttl_hours: 48,
        force_block_bypass_permissions: false,
        server_name: 'VPS-9',
      });
    });

    it('le runner existant devient le serveur par défaut de cet espace', async () => {
      expect(
        await sql`select space_id, name, location, status, config_source, is_default, url, token_hash, db_role,
                         max_concurrent_sessions, max_concurrent_sessions_cap, session_memory_limit_mb from environments`,
      ).toEqual([
        {
          space_id: spaceId,
          name: 'VPS-9',
          location: 'Gravelines',
          status: 'active',
          config_source: 'env',
          is_default: true,
          url: null,
          token_hash: null,
          db_role: null,
          max_concurrent_sessions: 6,
          max_concurrent_sessions_cap: 16,
          session_memory_limit_mb: 2048,
        },
      ]);
    });

    it('projets et lignes de travail sont rattachés à cet espace et à ce serveur', async () => {
      expect(await sql`select id, space_id, environment_id, github_source_id, created_by_user_id from projects order by slug`).toEqual([
        { id: ID.project, space_id: spaceId, environment_id: environmentId, github_source_id: ID.github, created_by_user_id: OWNER },
        { id: ID.projectArchived, space_id: spaceId, environment_id: environmentId, github_source_id: ID.github, created_by_user_id: OWNER },
      ]);
      for (const table of ['worktrees', 'sessions', 'command_runs', 'operations']) {
        const rows = await sql.unsafe<{ environment_id: string }[]>(`select distinct environment_id from "${table}"`);
        expect(rows, table).toEqual([{ environment_id: environmentId }]);
      }
      const [operation] = await sql`select project_id, environment_id from operations where id = ${ID.operationWithoutProject}`;
      expect(operation).toEqual({ project_id: null, environment_id: environmentId });
      expect(await sql`select actor_user_id from command_runs`).toEqual([{ actor_user_id: OWNER }]);
      expect(await sql`select id, project_id from pull_requests`).toEqual([{ id: ID.pullRequest, project_id: ID.project }]);
      expect(await sql`select project_id, mcp_server_id from project_mcp_servers`).toEqual([{ project_id: ID.project, mcp_server_id: ID.mcpFigma }]);
    });

    it("l'application GitHub devient une source de l'espace, avec le même identifiant", async () => {
      const rows = await sql`
        select id, space_id, kind, label, app_id, owner_login, owner_type, status, config, secrets_encrypted,
               last_checked_at, created_at
        from github_sources`;
      expect(rows).toEqual([
        {
          id: ID.github,
          space_id: spaceId,
          kind: 'app',
          label: 'Nuera Dev (Ethan)',
          app_id: '42',
          owner_login: 'nuera-studio',
          owner_type: 'Organization',
          status: 'connected',
          config: GITHUB_CONFIG,
          secrets_encrypted: 'v1:secret-github',
          last_checked_at: new Date('2026-11-04T10:00:00Z'),
          created_at: new Date('2026-10-02T09:00:00Z'),
        },
      ]);
      expect(await sql`select id, space_id, kind, secrets_encrypted from integrations`).toEqual([
        { id: ID.coolify, space_id: spaceId, kind: 'coolify', secrets_encrypted: 'v1:secret-coolify' },
      ]);
      expect(await sql`select distinct space_id from mcp_servers`).toEqual([{ space_id: spaceId }]);
    });

    it('les notifications vont au propriétaire, une seule non lue par clé, clés GitHub par source', async () => {
      const rows = await sql<{ id: string; user_id: string; space_id: string; dedup_key: string | null; read: boolean }[]>`
        select id, user_id, space_id, dedup_key, read_at is not null as read from notifications order by id`;
      expect(rows.every((row) => row.user_id === OWNER && row.space_id === spaceId)).toBe(true);
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      expect(byId[ID.notifNew]).toMatchObject({ dedup_key: `integration:github:${ID.github}:expired`, read: false });
      expect(byId[ID.notifOld]).toMatchObject({ dedup_key: `integration:github:${ID.github}:expired`, read: true });
      expect(byId[ID.notifError]).toMatchObject({ dedup_key: `integration:github:${ID.github}:error`, read: false });
      expect(byId[ID.notifCoolify]).toMatchObject({ dedup_key: 'integration:coolify:expiring', read: false });
      // Other keys keep their form; their duplicates are merged the same way.
      expect(byId[ID.notifClaudeNew]).toMatchObject({ dedup_key: 'claude:auth', read: false });
      expect(byId[ID.notifClaudeOld]).toMatchObject({ dedup_key: 'claude:auth', read: true });
      expect(byId[ID.notifMcp]).toMatchObject({ dedup_key: 'integration:mcp:figma:error', read: false });
      expect(byId[ID.notifRead]).toMatchObject({ dedup_key: 'session:x:turn:1', read: true });
      expect(byId[ID.notifPlain]).toMatchObject({ dedup_key: null, read: false });
      expect(byId[ID.notifPermission]).toMatchObject({ dedup_key: `permission:${ID.permission}`, read: false });
      expect(await sql`select user_id, endpoint, auth_session_id from push_subscriptions`).toEqual([
        { user_id: OWNER, endpoint: 'https://push.example.test/abc', auth_session_id: null },
      ]);
    });

    it("le journal connaît l'auteur, le compte concerné, l'espace et le serveur de chaque événement", async () => {
      const rows = await sql`
        select action, actor_label, subject_user_id, space_id, environment_id, metadata ->> 'email' as email
        from audit_log order by id`;
      expect(rows).toEqual([
        { action: 'auth.sign_in', actor_label: 'ethan@example.test', subject_user_id: OWNER, space_id: null, environment_id: null, email: null },
        { action: 'auth.sign_in_failed', actor_label: null, subject_user_id: OWNER, space_id: null, environment_id: null, email: 'ETHAN@example.test' },
        { action: 'auth.sign_in_failed', actor_label: null, subject_user_id: null, space_id: null, environment_id: null, email: 'inconnu@example.test' },
        { action: 'git.push', actor_label: 'ethan@example.test', subject_user_id: null, space_id: spaceId, environment_id: environmentId, email: null },
        {
          action: 'integration.github.write_token_issued',
          actor_label: null,
          subject_user_id: null,
          space_id: spaceId,
          environment_id: environmentId,
          email: null,
        },
        { action: 'settings.updated', actor_label: 'ethan@example.test', subject_user_id: null, space_id: null, environment_id: null, email: null },
        { action: 'security.push_subscribed', actor_label: 'ethan@example.test', subject_user_id: OWNER, space_id: null, environment_id: null, email: null },
        { action: 'integration.coolify.connected', actor_label: 'ethan@example.test', subject_user_id: null, space_id: spaceId, environment_id: null, email: null },
        { action: 'project.created', actor_label: 'ethan@example.test', subject_user_id: null, space_id: spaceId, environment_id: environmentId, email: null },
        { action: 'session.create', actor_label: 'ethan@example.test', subject_user_id: null, space_id: spaceId, environment_id: environmentId, email: null },
        { action: 'terminal.open', actor_label: 'ethan@example.test', subject_user_id: null, space_id: spaceId, environment_id: environmentId, email: null },
        { action: 'permission.decision', actor_label: 'ethan@example.test', subject_user_id: null, space_id: spaceId, environment_id: environmentId, email: null },
        { action: 'maintenance.auto', actor_label: null, subject_user_id: null, space_id: spaceId, environment_id: environmentId, email: null },
        // Metadata that is not an object is tolerated (no subject).
        { action: 'auth.sign_in_failed', actor_label: null, subject_user_id: null, space_id: null, environment_id: null, email: null },
      ]);
    });

    it("garde l'historique de disponibilité du runner (clé « runner » du serveur par défaut)", async () => {
      expect(await sql`select day::text, service, up_minutes from uptime_daily order by day, service`).toEqual([
        { day: '2026-11-01', service: 'runner', up_minutes: 1440 },
        { day: '2026-11-01', service: 'web', up_minutes: 1440 },
        { day: '2026-11-02', service: 'runner', up_minutes: 600 },
      ]);
    });

    it('les colonnes de rattachement sont obligatoires après la migration', async () => {
      const rows = await sql<{ table_name: string; column_name: string; is_nullable: string }[]>`
        select table_name, column_name, is_nullable from information_schema.columns
        where table_schema = 'public' and (
          (column_name = 'environment_id' and table_name in ('projects', 'worktrees', 'sessions', 'command_runs', 'operations'))
          or (column_name = 'space_id' and table_name in ('projects', 'integrations', 'mcp_servers', 'github_sources'))
          or (column_name = 'user_id' and table_name = 'notifications'))`;
      expect(rows).toHaveLength(10);
      expect(rows.filter((row) => row.is_nullable !== 'NO')).toEqual([]);
    });

    it('les accès web, la 2FA et les appareils de confiance existants restent valables', async () => {
      expect(await sql`select id, user_id from session`).toEqual([{ id: 'sess-1', user_id: OWNER }]);
      expect(await sql`select id from two_factor`).toEqual([{ id: 'tf-1' }]);
      expect(await sql`select identifier, value from verification`).toEqual([{ identifier: 'trust-device-abc', value: OWNER }]);
    });

    it("accepte ensuite d'autres comptes, mais pas un second propriétaire", async () => {
      await sql`insert into "user" (id, name, email) values ('member-1', 'Camille', 'camille@example.test')`;
      await expect(sql`update "user" set role = 'owner' where id = 'member-1'`).rejects.toThrow(/user_owner_idx/);
      await sql`delete from "user" where id = 'member-1'`;
    });

    it('une seconde exécution ne fait rien', async () => {
      const snapshot = await countRows(sql, [...KEPT_TABLES, 'spaces', 'environments', 'github_sources', 'integrations']);
      await runMigrations(url);
      const [row] = await sql<{ count: string }[]>`select count(*) from drizzle.__drizzle_migrations`;
      expect(row?.count).toBe('8');
      // 0007 on a filled database: the common Claude configuration starts empty, revision 0.
      expect(await sql`select id, revision from instance_claude_policy`).toEqual([{ id: 'instance', revision: 0 }]);
      expect(await countRows(sql, [...KEPT_TABLES, 'spaces', 'environments', 'github_sources', 'integrations'])).toEqual(snapshot);
    });
  });

  it('installation sans compte (avant /configuration) : serveur par défaut non attribué', async () => {
    const { url, sql } = await legacyDatabase(DATABASES.noUser);
    await sql`insert into app_settings (id, server_name, max_concurrent_sessions, theme) values (1, 'VPS-7', 5, 'dark')`;
    await sql`insert into uptime_daily (day, service, up_minutes, expected_minutes) values ('2026-11-01', 'runner', 30, 30)`;
    await runMigrations(url);
    expect(await sql`select space_id, name, status, config_source, is_default, max_concurrent_sessions from environments`).toEqual([
      { space_id: null, name: 'VPS-7', status: 'pending', config_source: 'env', is_default: true, max_concurrent_sessions: 5 },
    ]);
    expect(await countRows(sql, ['user', 'spaces', 'space_members', 'space_settings', 'user_preferences', 'uptime_daily'])).toEqual({
      user: 0,
      spaces: 0,
      space_members: 0,
      space_settings: 0,
      user_preferences: 0,
      uptime_daily: 1,
    });
    expect(await sql`select theme, server_name from app_settings`).toEqual([{ theme: 'dark', server_name: 'VPS-7' }]);
  });

  it('installation sans ligne app_settings : réglages par défaut', async () => {
    const { url, sql } = await legacyDatabase(DATABASES.noSettings);
    await sql`insert into "user" (id, name, email) values ('solo', 'Inès', 'ines@example.test')`;
    await sql`insert into projects (id, slug, name, github_full_name, clone_url, path)
              values (${ID.project}, 'site', 'Site', 'ines/site', 'https://github.com/ines/site.git', '/srv/dev/site')`;
    await sql`insert into integrations (id, kind) values (${ID.coolify}, 'coolify')`;
    await runMigrations(url);
    expect(await sql`select id, web_session_idle_hours, web_session_max_days, invitation_ttl_hours from app_settings`).toEqual([
      { id: 1, web_session_idle_hours: 12, web_session_max_days: 30, invitation_ttl_hours: 48 },
    ]);
    const [space] = await sql<{ id: string; name: string }[]>`select id, name from spaces`;
    expect(space?.name).toBe("Espace d'Inès");
    expect(await sql`select space_id, name, status, max_concurrent_sessions from environments`).toEqual([
      { space_id: space!.id, name: 'VPS-3', status: 'active', max_concurrent_sessions: 4 },
    ]);
    expect(
      await sql`select default_model, default_permission_mode, block_bypass_permissions, permission_wait_seconds, worktree_stale_days from space_settings`,
    ).toEqual([{ default_model: null, default_permission_mode: 'manual', block_bypass_permissions: true, permission_wait_seconds: 120, worktree_stale_days: 30 }]);
    expect(await sql`select theme, locale from user_preferences`).toEqual([{ theme: 'light', locale: 'fr' }]);
    expect(await sql`select space_id, github_source_id, created_by_user_id from projects`).toEqual([
      { space_id: space!.id, github_source_id: null, created_by_user_id: 'solo' },
    ]);
    expect(await sql`select space_id from integrations`).toEqual([{ space_id: space!.id }]);
    expect(await sql`select role from "user"`).toEqual([{ role: 'owner' }]);
  });

  it('plusieurs comptes : le plus ancien devient propriétaire, chacun reçoit son espace', async () => {
    const { url, sql } = await legacyDatabase(DATABASES.severalUsers);
    // A 0000 database holds one account at most (user_single_owner_idx): its guard is neutralised to
    // check that the backfill still gives a correct result with several accounts.
    await sql`drop index user_single_owner_idx`;
    await sql`create index user_single_owner_idx on "user" (id)`;
    await sql`insert into "user" (id, name, email, created_at) values ('b-newer', 'Bruno', 'bruno@example.test', '2026-10-05T00:00:00Z')`;
    await sql`insert into "user" (id, name, email, created_at) values ('a-older', '  alice Martin ', 'alice@example.test', '2026-10-01T00:00:00Z')`;
    await sql`insert into app_settings (id, theme) values (1, 'system')`;
    await sql`insert into projects (id, slug, name, github_full_name, clone_url, path)
              values (${ID.project}, 'site', 'Site', 'alice/site', 'https://github.com/alice/site.git', '/srv/dev/site')`;
    await sql`insert into command_runs (project_id, kind, command) values (${ID.project}, 'test', 'npm test')`;
    await sql`insert into notifications (kind, title) values ('server', 'Serveur redémarré')`;
    await runMigrations(url);
    expect(await sql`select id, role from "user" order by id`).toEqual([
      { id: 'a-older', role: 'owner' },
      { id: 'b-newer', role: 'member' },
    ]);
    const spaces = await sql<{ id: string; name: string; owner_user_id: string }[]>`select id, name, owner_user_id from spaces order by owner_user_id`;
    expect(spaces.map((space) => [space.owner_user_id, space.name])).toEqual([
      ['a-older', "Espace d'alice"],
      ['b-newer', 'Espace de Bruno'],
    ]);
    const ownerSpace = spaces[0]!.id;
    expect(await sql`select user_id, role from space_members order by user_id`).toEqual([
      { user_id: 'a-older', role: 'owner' },
      { user_id: 'b-newer', role: 'owner' },
    ]);
    expect(await countRows(sql, ['space_settings', 'user_preferences'])).toEqual({ space_settings: 2, user_preferences: 2 });
    expect(await sql`select distinct theme from user_preferences`).toEqual([{ theme: 'system' }]);
    expect(await sql`select space_id, status from environments`).toEqual([{ space_id: ownerSpace, status: 'active' }]);
    // Several accounts: the author of former rows is unknown, so it stays empty.
    expect(await sql`select space_id, created_by_user_id from projects`).toEqual([{ space_id: ownerSpace, created_by_user_id: null }]);
    expect(await sql`select actor_user_id from command_runs`).toEqual([{ actor_user_id: null }]);
    expect(await sql`select user_id, space_id from notifications`).toEqual([{ user_id: 'a-older', space_id: ownerSpace }]);
  });

  it("données sans aucun compte : un espace initial sans propriétaire les accueille", async () => {
    const { url, sql } = await legacyDatabase(DATABASES.orphans);
    await sql`insert into projects (id, slug, name, github_full_name, clone_url, path)
              values (${ID.project}, 'site', 'Site', 'x/site', 'https://github.com/x/site.git', '/srv/dev/site')`;
    await sql`insert into integrations (id, kind, config) values (${ID.github}, 'github', ${sql.json({ appId: 'pas-un-nombre' })})`;
    await sql`insert into mcp_servers (id, name, label, transport) values (${ID.mcpFigma}, 'figma', 'Figma', 'http')`;
    await sql`insert into notifications (kind, title, dedup_key) values ('integration_error', 'GitHub ne répond plus', 'integration:github:error')`;
    await sql`insert into audit_log (action, summary, actor_kind) values ('project.created', 'projet créé', 'system')`;
    await runMigrations(url);
    const [space] = await sql<{ id: string; name: string; owner_user_id: string | null }[]>`select id, name, owner_user_id from spaces`;
    expect(space).toMatchObject({ name: 'Espace initial', owner_user_id: null });
    expect(await sql`select space_id, status from environments`).toEqual([{ space_id: space!.id, status: 'active' }]);
    expect(await sql`select space_id, github_source_id from projects`).toEqual([{ space_id: space!.id, github_source_id: ID.github }]);
    // A malformed app id gives a null app_id instead of a failed migration.
    expect(await sql`select id, space_id, app_id from github_sources`).toEqual([{ id: ID.github, space_id: space!.id, app_id: null }]);
    expect(await sql`select space_id from mcp_servers`).toEqual([{ space_id: space!.id }]);
    expect(await countRows(sql, ['notifications', 'space_members', 'user_preferences', 'integrations'])).toEqual({
      notifications: 0,
      space_members: 0,
      user_preferences: 0,
      integrations: 0,
    });
    expect(await sql`select space_id, environment_id from audit_log`).toEqual([
      { space_id: space!.id, environment_id: (await sql`select id from environments`)[0]!.id },
    ]);
  });
});
