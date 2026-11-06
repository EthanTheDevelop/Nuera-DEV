import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from './index';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate';
import {
  commandRuns,
  environments,
  operations,
  permissionRequests,
  projects,
  sessionEvents,
  sessions,
  uptimeDaily,
  worktrees,
} from './schema';
import * as schema from './schema';
import { seedMember, seedOwner, type SeededAccount } from './test/fixtures';
import {
  adminClient,
  createRunnerLoginRole,
  databaseUrl,
  dropDatabase,
  dropRole,
  pgAvailable,
  pgFailure,
  recreateDatabase,
  testName,
} from './test/pg';

/**
 * Restricted runner roles (migration 0004, docs/MULTICOMPTE.md §11): a login role IN ROLE
 * nuera_runner, bound to one server through environments.db_role, only reaches the runner tables and
 * only the rows of its server. The table owner (web, default runner with the full DSN) is unaffected.
 */

const DB_NAME = testName('rls');
const ROLE_A = testName('rls_env_a');
const ROLE_B = testName('rls_env_b');
const ROLE_UNBOUND = testName('rls_unbound');
/** Login role outside nuera_runner. */
const ROLE_OUTSIDER = testName('rls_outsider');
/** Stands for nuera_runner when replaying the role creation of 0004 (roles are cluster-wide). */
const ROLE_PROBE = testName('rls_probe_runner');
const PASSWORD = randomBytes(18).toString('hex');

/** Tables the runner works on (row-level security by server). */
const RUNNER_TABLES = [
  'environments',
  'projects',
  'worktrees',
  'sessions',
  'session_events',
  'permission_requests',
  'operations',
  'command_runs',
  'uptime_daily',
  'space_settings',
];

/**
 * Work rows and availability: SELECT and INSERT on the table, UPDATE on every column, never a
 * table-level UPDATE (it would allow LOCK TABLE … ACCESS EXCLUSIVE). Read from the Drizzle schema: a
 * column added to one of these tables fails this suite until its grant exists.
 */
const WORK_TABLES = [worktrees, sessions, sessionEvents, permissionRequests, operations, commandRuns, uptimeDaily].map((table) =>
  getTableConfig(table),
);

/** Columns of `environments` a runner reads: all of them but the token ciphertexts. */
const ENVIRONMENT_READ_COLUMNS = [
  'backend',
  'capabilities',
  'config_source',
  'contract_version',
  'created_at',
  'db_role',
  'id',
  'is_default',
  'last_error',
  'last_seen_at',
  'location',
  'max_concurrent_sessions',
  'max_concurrent_sessions_cap',
  'name',
  'next_token_hash',
  'runner_version',
  'session_memory_limit_mb',
  'space_id',
  'status',
  'token_hash',
  'token_rotated_at',
  'updated_at',
  'url',
];
/** Its heartbeat. */
const ENVIRONMENT_WRITE_COLUMNS = ['backend', 'capabilities', 'contract_version', 'last_seen_at', 'runner_version', 'updated_at'];
/** Clone and synchronisation state of a project. */
const PROJECT_WRITE_COLUMNS = [
  'ahead_by',
  'behind_by',
  'claude_md_commit_sha',
  'claude_md_updated_at',
  'commands',
  'current_branch',
  'default_branch',
  'last_commit_at',
  'last_commit_message',
  'last_commit_sha',
  'last_fetched_at',
  'last_synced_at',
  'path',
  'status',
  'status_detail',
  'sync_state',
  'updated_at',
];

const available = await pgAvailable('rls.test');

/** Tables a runner role must never read. */
const FORBIDDEN_TABLES = [
  // Configuration Claude commune (0007): read by the web only, served to the runner over HTTP.
  'instance_rules',
  'instance_skills',
  'instance_skill_files',
  'instance_mcp_servers',
  'instance_claude_policy',
  'instance_config_versions',
  'instance_config_proposals',
  'space_claude_overrides',
  'session_claude_config',
  'user',
  'session',
  'account',
  'verification',
  'two_factor',
  'passkey',
  'spaces',
  'space_members',
  'user_preferences',
  'invitations',
  'integrations',
  'github_sources',
  'mcp_servers',
  'project_mcp_servers',
  'project_env_vars',
  'pull_requests',
  'notifications',
  'push_subscriptions',
  'audit_log',
];

describe.skipIf(!available)('rôles restreints des runners (RLS)', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let db: Database;
  let runnerA: postgres.Sql;
  let runnerB: postgres.Sql;
  let unbound: postgres.Sql;
  let owner: SeededAccount;
  let member: SeededAccount;
  const url = databaseUrl(DB_NAME);
  const ids = {
    projectA: randomUUID(),
    projectB: randomUUID(),
    worktreeA: randomUUID(),
    worktreeB: randomUUID(),
    sessionA: randomUUID(),
    sessionB: randomUUID(),
    permissionA: randomUUID(),
    permissionB: randomUUID(),
    runA: randomUUID(),
    runB: randomUUID(),
    operationA: randomUUID(),
    operationB: randomUUID(),
    operationBWithoutProject: randomUUID(),
  };

  beforeAll(async () => {
    admin = adminClient();
    await recreateDatabase(admin, DB_NAME);
    await runMigrations(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    db = createDb(url, { max: 2 });
    owner = await seedOwner(db, { email: 'owner@example.test' });
    member = await seedMember(db, { email: 'membre@example.test', environment: { name: 'Serveur B', dbRole: ROLE_B } });
    const envA = owner.environmentId!;
    const envB = member.environmentId!;
    await sql`update environments set db_role = ${ROLE_A} where id = ${envA}`;
    await sql`update environments set token_hash = 'hash-b', next_token_hash = 'next-hash-b',
                token_encrypted = 'cipher-b', next_token_encrypted = 'cipher-next-b' where id = ${envB}`;

    // Same slug, folder and repository on both servers (unique per server only).
    for (const [projectId, spaceId, environmentId] of [
      [ids.projectA, owner.spaceId, envA],
      [ids.projectB, member.spaceId, envB],
    ] as const) {
      await sql`insert into projects (id, space_id, environment_id, slug, name, github_full_name, clone_url, path, status)
                values (${projectId}, ${spaceId}, ${environmentId}, 'nuera-os', 'Nuera OS', 'nuera-studio/nuera-os',
                        'https://github.com/nuera-studio/nuera-os.git', '/srv/dev/nuera-os', 'ready')`;
    }
    const rows = [
      { project: ids.projectA, env: envA, worktree: ids.worktreeA, session: ids.sessionA, permission: ids.permissionA, run: ids.runA, operation: ids.operationA },
      { project: ids.projectB, env: envB, worktree: ids.worktreeB, session: ids.sessionB, permission: ids.permissionB, run: ids.runB, operation: ids.operationB },
    ];
    for (const row of rows) {
      await sql`insert into worktrees (id, project_id, environment_id, name, branch, path, is_primary)
                values (${row.worktree}, ${row.project}, ${row.env}, 'nuera-os', 'main', '/srv/dev/nuera-os', true)`;
      await sql`insert into sessions (id, project_id, environment_id, worktree_id, title, status)
                values (${row.session}, ${row.project}, ${row.env}, ${row.worktree}, 'Session', 'running')`;
      await sql`insert into session_events (session_id, position, version, kind, payload)
                values (${row.session}, 1, 1, 'system', ${sql.json({ message: 'ok', at: '2026-11-05T10:00:00Z' })})`;
      await sql`insert into permission_requests (id, session_id, tool_name, tool_input, title)
                values (${row.permission}, ${row.session}, 'Bash', ${sql.json({ command: 'ls' })}, 'Commande')`;
      await sql`insert into command_runs (id, project_id, environment_id, kind, command)
                values (${row.run}, ${row.project}, ${row.env}, 'test', 'npm test')`;
      await sql`insert into operations (id, kind, project_id, environment_id) values (${row.operation}, 'pull', ${row.project}, ${row.env})`;
    }
    await sql`insert into operations (id, kind, environment_id) values (${ids.operationBWithoutProject}, 'maintenance', ${envB})`;
    await sql`insert into uptime_daily (day, service, up_minutes) values
                ('2026-11-01', 'runner', 10), ('2026-11-01', ${`runner:${envB}`}, 20), ('2026-11-01', 'web', 30)`;
    // Rows of tables a runner must never reach.
    await sql`insert into github_sources (space_id, app_id, secrets_encrypted) values (${member.spaceId}, 77, 'cipher-github')`;
    await sql`insert into integrations (space_id, kind, secrets_encrypted) values (${member.spaceId}, 'coolify', 'cipher-coolify')`;
    await sql`insert into project_env_vars (project_id, key, value_encrypted) values (${ids.projectB}, 'API_KEY', 'cipher-var')`;
    await sql`insert into notifications (user_id, space_id, kind, title) values (${member.userId}, ${member.spaceId}, 'server', 'N')`;
    await sql`insert into audit_log (action, summary) values ('auth.sign_in', 'connexion')`;

    await createRunnerLoginRole(admin, ROLE_A, PASSWORD);
    await createRunnerLoginRole(admin, ROLE_B, PASSWORD);
    await createRunnerLoginRole(admin, ROLE_UNBOUND, PASSWORD);
    const connect = (user: string) => postgres(databaseUrl(DB_NAME, { user, password: PASSWORD }), { max: 1, onnotice: () => {} });
    runnerA = connect(ROLE_A);
    runnerB = connect(ROLE_B);
    unbound = connect(ROLE_UNBOUND);
  });

  afterAll(async () => {
    for (const client of [runnerA, runnerB, unbound, sql]) await client?.end({ timeout: 5 }).catch(() => {});
    await db?.$client.end({ timeout: 5 }).catch(() => {});
    if (admin) {
      await dropDatabase(admin, DB_NAME);
      for (const role of [ROLE_A, ROLE_B, ROLE_UNBOUND, ROLE_OUTSIDER, ROLE_PROBE]) await dropRole(admin, role);
      await admin.end({ timeout: 5 });
    }
  });

  it('identifie le serveur du rôle connecté', async () => {
    expect(await runnerB`select public.nuera_runner_environment_id() as id`).toEqual([{ id: member.environmentId }]);
    expect(await runnerA`select public.nuera_runner_environment_id() as id`).toEqual([{ id: owner.environmentId }]);
    expect(await unbound`select public.nuera_runner_environment_id() as id`).toEqual([{ id: null }]);
  });

  it('ne voit que les lignes de son serveur', async () => {
    expect(await runnerB`select id from projects`).toEqual([{ id: ids.projectB }]);
    expect(await runnerB`select id from worktrees`).toEqual([{ id: ids.worktreeB }]);
    expect(await runnerB`select id from sessions`).toEqual([{ id: ids.sessionB }]);
    expect(await runnerB`select session_id from session_events`).toEqual([{ session_id: ids.sessionB }]);
    expect(await runnerB`select id from permission_requests`).toEqual([{ id: ids.permissionB }]);
    expect(await runnerB`select id from command_runs`).toEqual([{ id: ids.runB }]);
    expect((await runnerB<{ id: string }[]>`select id from operations order by id`).map((row) => row.id).sort()).toEqual(
      [ids.operationB, ids.operationBWithoutProject].sort(),
    );
    expect(await runnerB`select space_id from space_settings`).toEqual([{ space_id: member.spaceId }]);
    expect(await runnerA`select id from projects`).toEqual([{ id: ids.projectA }]);
    for (const table of ['projects', 'worktrees', 'sessions', 'session_events', 'operations', 'environments', 'space_settings', 'uptime_daily']) {
      const [row] = await unbound.unsafe<{ count: string }[]>(`select count(*) from "${table}"`);
      expect(row?.count, table).toBe('0');
    }
  });

  it('lit sa ligne de serveur (empreintes comprises) mais jamais les jetons chiffrés', async () => {
    expect(await runnerB`select id, name, status, token_hash, next_token_hash, max_concurrent_sessions from environments`).toEqual([
      { id: member.environmentId, name: 'Serveur B', status: 'active', token_hash: 'hash-b', next_token_hash: 'next-hash-b', max_concurrent_sessions: 4 },
    ]);
    await expect(runnerB`select token_encrypted from environments`).rejects.toThrow(/permission denied/);
    await expect(runnerB`select next_token_encrypted from environments`).rejects.toThrow(/permission denied/);
    await expect(runnerB`select * from environments`).rejects.toThrow(/permission denied/);
  });

  it("n'écrit que son battement sur sa ligne de serveur", async () => {
    const beat = await runnerB`
      update environments set last_seen_at = now(), runner_version = '1.2.3', contract_version = 2, backend = 'pty',
             capabilities = ${runnerB.json({ claudeVersion: '2.1.0' })}, updated_at = now()
      where id = ${member.environmentId!}`;
    expect(beat.count).toBe(1);
    const other = await runnerB`update environments set last_seen_at = now() where id = ${owner.environmentId!}`;
    expect(other.count).toBe(0);
    for (const column of ['name', 'status', 'space_id', 'token_hash', 'db_role', 'max_concurrent_sessions', 'last_error']) {
      await expect(
        runnerB.unsafe(`update environments set "${column}" = "${column}" where id = $1`, [member.environmentId!]),
        column,
      ).rejects.toThrow(/permission denied/);
    }
    await expect(runnerB`insert into environments (name) values ('Intrus')`).rejects.toThrow(/permission denied/);
    await expect(runnerB`delete from environments`).rejects.toThrow(/permission denied/);
  });

  it("met à jour l'état de ses projets, jamais leur espace ni leur serveur", async () => {
    const own = await runnerB`update projects set status_detail = 'Synchronisation : ok', sync_state = 'up_to_date', updated_at = now()
                              where id = ${ids.projectB}`;
    expect(own.count).toBe(1);
    const foreign = await runnerB`update projects set status_detail = 'piraté' where id = ${ids.projectA}`;
    expect(foreign.count).toBe(0);
    await expect(runnerB`update projects set space_id = ${owner.spaceId} where id = ${ids.projectB}`).rejects.toThrow(/permission denied/);
    await expect(runnerB`update projects set environment_id = ${owner.environmentId!} where id = ${ids.projectB}`).rejects.toThrow(
      /permission denied/,
    );
    await expect(runnerB`update projects set name = 'x' where id = ${ids.projectB}`).rejects.toThrow(/permission denied/);
    await expect(
      runnerB`insert into projects (space_id, environment_id, slug, name, github_full_name, clone_url, path)
              values (${member.spaceId}, ${member.environmentId!}, 'x', 'x', 'x/x', 'x', '/x')`,
    ).rejects.toThrow(/permission denied/);
    await expect(runnerB`delete from projects where id = ${ids.projectB}`).rejects.toThrow(/permission denied/);
    const [check] = await sql`select status_detail from projects where id = ${ids.projectA}`;
    expect(check).toEqual({ status_detail: null });
  });

  it("crée et modifie ses lignes de travail, jamais celles d'un autre serveur", async () => {
    const worktreeId = randomUUID();
    await runnerB`insert into worktrees (id, project_id, environment_id, name, branch, path)
                  values (${worktreeId}, ${ids.projectB}, ${member.environmentId!}, 'crm', 'crm', '/srv/dev/.worktrees/nuera-os/crm')`;
    // A removed worktree keeps its row (the runner never deletes one).
    const removed = await runnerB`update worktrees set status = 'removed', removed_at = now() where id = ${worktreeId}`;
    expect(removed.count).toBe(1);
    await expect(runnerB`delete from worktrees where id = ${worktreeId}`).rejects.toThrow(/permission denied/);
    await expect(
      runnerB`insert into worktrees (project_id, environment_id, name, branch, path)
              values (${ids.projectA}, ${owner.environmentId!}, 'crm', 'crm', '/srv/dev/.worktrees/nuera-os/crm')`,
    ).rejects.toThrow(/row-level security/);
    await expect(runnerB`update sessions set environment_id = ${owner.environmentId!} where id = ${ids.sessionB}`).rejects.toThrow(
      /row-level security|sessions_project_env_fk/,
    );
    expect((await runnerB`update sessions set status = 'interrupted' where id = ${ids.sessionA}`).count).toBe(0);
    expect((await runnerB`update operations set status = 'failed'`).count).toBe(2);
    expect((await runnerB`update command_runs set status = 'stopped'`).count).toBe(1);
    await runnerB`insert into session_events (session_id, position, version, kind, payload)
                  values (${ids.sessionB}, 2, 2, 'system', ${runnerB.json({ message: 'ok', at: '2026-11-05T10:00:00Z' })})`;
    await expect(
      runnerB`insert into session_events (session_id, position, version, kind, payload)
              values (${ids.sessionA}, 2, 2, 'system', ${runnerB.json({ message: 'intrus', at: '2026-11-05T10:00:00Z' })})`,
    ).rejects.toThrow(/row-level security/);
    await expect(runnerB`update permission_requests set status = 'denied' where id = ${ids.permissionA}`).resolves.toHaveProperty(
      'count',
      0,
    );
    const statuses = await sql`select id, status from sessions order by id`;
    expect(statuses.find((row) => row.id === ids.sessionA)).toEqual({ id: ids.sessionA, status: 'running' });
    const [operationA] = await sql`select status from operations where id = ${ids.operationA}`;
    expect(operationA).toEqual({ status: 'queued' });
  });

  it("ne déplace jamais une ligne vers un autre serveur, même quand les clés étrangères l'accepteraient", async () => {
    const envA = owner.environmentId!;
    // Project and server both switched: the composite foreign key is satisfied, only WITH CHECK refuses.
    for (const [table, id] of [
      ['worktrees', ids.worktreeB],
      ['sessions', ids.sessionB],
      ['command_runs', ids.runB],
      ['operations', ids.operationB],
    ] as const) {
      await expect(
        runnerB.unsafe(`update "${table}" set project_id = $1, environment_id = $2 where id = $3`, [ids.projectA, envA, id]),
        table,
      ).rejects.toThrow(/row-level security/);
    }
    // An operation without project is only tied to its server by row-level security.
    await expect(runnerB`update operations set environment_id = ${envA} where id = ${ids.operationBWithoutProject}`).rejects.toThrow(
      /row-level security/,
    );
    await expect(runnerB`insert into operations (kind, environment_id) values ('maintenance', ${envA})`).rejects.toThrow(/row-level security/);
    await expect(
      runnerB`insert into sessions (id, project_id, environment_id, title) values (${randomUUID()}, ${ids.projectA}, ${envA}, 'Intruse')`,
    ).rejects.toThrow(/row-level security/);
    await expect(
      runnerB`insert into command_runs (project_id, environment_id, kind, command) values (${ids.projectA}, ${envA}, 'test', 'npm test')`,
    ).rejects.toThrow(/row-level security/);
    // Neither an authorisation nor an event moves into a session of another server.
    await expect(runnerB`update permission_requests set session_id = ${ids.sessionA} where id = ${ids.permissionB}`).rejects.toThrow(
      /row-level security/,
    );
    await expect(runnerB`update session_events set session_id = ${ids.sessionA} where session_id = ${ids.sessionB}`).rejects.toThrow(
      /row-level security/,
    );
    await expect(
      runnerB`insert into permission_requests (session_id, tool_name, tool_input, title)
              values (${ids.sessionA}, 'Bash', ${runnerB.json({ command: 'id' })}, 'Intruse')`,
    ).rejects.toThrow(/row-level security/);
    // Nothing moved.
    expect(await sql`select environment_id from operations where id = ${ids.operationBWithoutProject}`).toEqual([
      { environment_id: member.environmentId },
    ]);
    expect(await sql`select project_id, environment_id from sessions where id = ${ids.sessionB}`).toEqual([
      { project_id: ids.projectB, environment_id: member.environmentId },
    ]);
    expect(await sql`select session_id from permission_requests where id = ${ids.permissionB}`).toEqual([{ session_id: ids.sessionB }]);
  });

  it("ne relie jamais ses lignes au worktree ou à la session d'un autre serveur (clés composites de 0005)", async () => {
    await expect(runnerB`update sessions set worktree_id = ${ids.worktreeA} where id = ${ids.sessionB}`).rejects.toThrow(
      /sessions_worktree_env_fk/,
    );
    await expect(runnerB`update operations set worktree_id = ${ids.worktreeA} where id = ${ids.operationB}`).rejects.toThrow(
      /operations_worktree_env_fk/,
    );
    await expect(runnerB`update operations set session_id = ${ids.sessionA} where id = ${ids.operationB}`).rejects.toThrow(
      /operations_session_env_fk/,
    );
    await expect(runnerB`update command_runs set worktree_id = ${ids.worktreeA} where id = ${ids.runB}`).rejects.toThrow(
      /command_runs_worktree_env_fk/,
    );
    await expect(
      runnerB`insert into sessions (id, project_id, environment_id, worktree_id, title)
              values (${randomUUID()}, ${ids.projectB}, ${member.environmentId!}, ${ids.worktreeA}, 'Intruse')`,
    ).rejects.toThrow(/sessions_worktree_env_fk/);
    await expect(
      runnerB`insert into command_runs (project_id, environment_id, worktree_id, kind, command)
              values (${ids.projectB}, ${member.environmentId!}, ${ids.worktreeA}, 'test', 'npm test')`,
    ).rejects.toThrow(/command_runs_worktree_env_fk/);
    await expect(
      runnerB`insert into operations (kind, environment_id, worktree_id, session_id)
              values ('maintenance', ${member.environmentId!}, ${ids.worktreeB}, ${ids.sessionA})`,
    ).rejects.toThrow(/operations_session_env_fk/);
    // Its own worktree and session: accepted.
    expect((await runnerB`update operations set worktree_id = ${ids.worktreeB}, session_id = ${ids.sessionB} where id = ${ids.operationB}`).count).toBe(1);
    expect(await sql`select worktree_id from sessions where id = ${ids.sessionB}`).toEqual([{ worktree_id: ids.worktreeB }]);
    expect(await sql`select worktree_id from command_runs where id = ${ids.runB}`).toEqual([{ worktree_id: null }]);
  });

  it("ne prend aucun verrou consultatif, sauf le bail de son propre serveur (0005)", async () => {
    const lockFunctions = await sql<{ fn: string; name: string; ints: boolean }[]>`
      select p.oid::regprocedure::text as fn, p.proname as name, p.proargtypes[0] = 'integer'::regtype::oid as ints
      from pg_proc p
      where p.pronamespace = 'pg_catalog'::regnamespace and p.proname ~ '^pg_(try_)?advisory_(xact_)?lock(_shared)?$'
      order by 1`;
    // Session and transaction, exclusive and shared, blocking and « try »: (bigint) and (integer, integer).
    expect(lockFunctions).toHaveLength(16);
    for (const { fn, name, ints } of lockFunctions) {
      const args = ints ? '1, 2' : `hashtextextended('nuera:migrate', 0)`;
      await expect(runnerB.begin((tx) => tx.unsafe(`select pg_catalog.${name}(${args})`)), fn).rejects.toThrow(/permission denied/);
      expect(
        await sql<{ runner: boolean; login: boolean }[]>`
          select has_function_privilege('nuera_runner', ${fn}, 'EXECUTE') as runner,
                 has_function_privilege(${ROLE_B}, ${fn}, 'EXECUTE') as login`,
        fn,
      ).toEqual([{ runner: false, login: false }]);
    }
    // The web and migrate (table owner) keep them: the migration lock, the scheduler's (integer, integer) pair.
    expect(await sql`select pg_try_advisory_lock(hashtextextended('nuera:migrate', 0)) as locked`).toEqual([{ locked: true }]);
    expect(await sql`select pg_advisory_unlock(hashtextextended('nuera:migrate', 0)) as released`).toEqual([{ released: true }]);
    expect(await sql`select pg_try_advisory_lock(1, 2) as locked`).toEqual([{ locked: true }]);
    expect(await sql`select pg_advisory_unlock(1, 2) as released`).toEqual([{ released: true }]);

    const leaseKey = (environmentId: string) => `nuera:environment:${environmentId}`;
    const ownerTries = async (environmentId: string) => {
      const [row] = await sql<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtextextended(${leaseKey(environmentId)}, 0)) as locked`;
      if (row?.locked) await sql`select pg_advisory_unlock(hashtextextended(${leaseKey(environmentId)}, 0))`;
      return row?.locked;
    };
    const secondB = postgres(databaseUrl(DB_NAME, { user: ROLE_B, password: PASSWORD }), { max: 1, onnotice: () => {} });
    try {
      expect(await runnerB`select public.nuera_runner_try_lease() as locked`).toEqual([{ locked: true }]);
      // Same key as a runner using the full DSN (they exclude each other); the other server's key stays free.
      expect(await ownerTries(member.environmentId!)).toBe(false);
      expect(await ownerTries(owner.environmentId!)).toBe(true);
      // A second runner of the same server waits; another server takes its own lease, never B's.
      expect(await secondB`select public.nuera_runner_try_lease() as locked`).toEqual([{ locked: false }]);
      expect(await runnerA`select public.nuera_runner_try_lease() as locked`).toEqual([{ locked: true }]);
      expect(await ownerTries(owner.environmentId!)).toBe(false);
      expect(await unbound`select public.nuera_runner_try_lease() as locked`).toEqual([{ locked: false }]);
      expect(await unbound`select public.nuera_runner_release_lease() as released`).toEqual([{ released: false }]);
      // Released: the second runner of B gets it.
      expect(await runnerB`select public.nuera_runner_release_lease() as released`).toEqual([{ released: true }]);
      expect(await secondB`select public.nuera_runner_try_lease() as locked`).toEqual([{ locked: true }]);
      expect(await secondB`select public.nuera_runner_release_lease() as released`).toEqual([{ released: true }]);
      expect(await runnerA`select public.nuera_runner_release_lease() as released`).toEqual([{ released: true }]);
      expect(await ownerTries(member.environmentId!)).toBe(true);
      // A retired server can no longer take its lease.
      await sql`update environments set status = 'retired' where id = ${member.environmentId!}`;
      expect(await runnerB`select public.nuera_runner_try_lease() as locked`).toEqual([{ locked: false }]);
    } finally {
      await sql`update environments set status = 'active' where id = ${member.environmentId!}`;
      await secondB.end({ timeout: 5 });
    }

    const functions = await sql<{ proname: string; prosecdef: boolean; proconfig: string[]; grantees: string[] }[]>`
      select p.proname, p.prosecdef, p.proconfig,
             array(select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end
                   from aclexplode(p.proacl) a where a.privilege_type = 'EXECUTE' order by 1) as grantees
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname in ('nuera_runner_try_lease', 'nuera_runner_release_lease')
      order by 1`;
    expect(functions.map(({ proname, prosecdef, proconfig }) => ({ proname, prosecdef, proconfig }))).toEqual([
      { proname: 'nuera_runner_release_lease', prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'] },
      { proname: 'nuera_runner_try_lease', prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'] },
    ]);
    for (const { proname, grantees } of functions) {
      expect(grantees, proname).toContain('nuera_runner');
      expect(grantees, proname).not.toContain('PUBLIC');
    }
  });

  it("ne supprime ni ne vide aucune table (TRUNCATE ignorerait la sécurité au niveau des lignes)", async () => {
    for (const table of [...RUNNER_TABLES, 'app_settings']) {
      await expect(runnerB.unsafe(`delete from "${table}"`), `delete ${table}`).rejects.toThrow(/permission denied/);
      await expect(runnerB.unsafe(`truncate "${table}"`), `truncate ${table}`).rejects.toThrow(/permission denied/);
    }
    const [counts] = await sql<{ sessions: number; operations: number; uptime: number }[]>`
      select (select count(*)::int from sessions) as sessions, (select count(*)::int from operations) as operations,
             (select count(*)::int from uptime_daily) as uptime`;
    expect(counts).toEqual({ sessions: 2, operations: 3, uptime: 3 });
  });

  it("ne verrouille aucune table plus fort que ROW EXCLUSIVE (un verrou exclusif bloquerait tous les serveurs et le web)", async () => {
    for (const table of [...RUNNER_TABLES, 'app_settings']) {
      for (const mode of ['ACCESS EXCLUSIVE', 'EXCLUSIVE', 'SHARE']) {
        await expect(
          runnerB.begin((tx) => tx.unsafe(`lock table "${table}" in ${mode} mode`)),
          `${table} ${mode}`,
        ).rejects.toThrow(/permission denied/);
      }
    }
    // Its own work still takes the row locks it needs.
    await runnerB.begin(async (tx) => {
      expect(await tx`select id from sessions where id = ${ids.sessionB} for update`).toEqual([{ id: ids.sessionB }]);
      expect(await tx`select id from sessions where id = ${ids.sessionA} for update`).toEqual([]);
    });
  });

  it("n'utilise que la séquence des événements de session", async () => {
    await expect(runnerB`select nextval('public.audit_log_id_seq')`).rejects.toThrow(/permission denied/);
    // USAGE only: the global counter of events stays unreadable.
    await expect(runnerB`select last_value from public.session_events_id_seq`).rejects.toThrow(/permission denied/);
  });

  it("fonction d'identité : SECURITY DEFINER, search_path figé, réservée à nuera_runner", async () => {
    expect(
      await sql`select prosecdef, provolatile, proconfig from pg_proc
                where proname = 'nuera_runner_environment_id' and pronamespace = 'public'::regnamespace`,
    ).toEqual([{ prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, pg_temp'] }]);
    // A temporary table named like the real one does not redirect the lookup (nor the policies).
    await runnerB.begin(async (tx) => {
      await tx`create temporary table environments (id uuid, db_role text, status text) on commit drop`;
      await tx`insert into environments values (${owner.environmentId!}, ${ROLE_B}, 'active')`;
      expect(await tx`select public.nuera_runner_environment_id() as id`).toEqual([{ id: member.environmentId }]);
      expect(await tx`select id from public.projects`).toEqual([{ id: ids.projectB }]);
    });
    // Switching to the group role keeps the scope of the login role (session_user).
    await runnerB.begin(async (tx) => {
      await tx`set local role nuera_runner`;
      expect(await tx`select id from projects`).toEqual([{ id: ids.projectB }]);
    });
    await dropRole(admin, ROLE_OUTSIDER);
    await admin.unsafe(`create role "${ROLE_OUTSIDER}" login password '${PASSWORD}'`);
    const outsider = postgres(databaseUrl(DB_NAME, { user: ROLE_OUTSIDER, password: PASSWORD }), { max: 1, onnotice: () => {} });
    try {
      await expect(outsider`select public.nuera_runner_environment_id()`).rejects.toThrow(/permission denied/);
      await expect(outsider`select count(*) from projects`).rejects.toThrow(/permission denied/);
    } finally {
      await outsider.end({ timeout: 5 });
    }
  });

  it('droits exacts du rôle nuera_runner (liste de contrôle : toute nouvelle table du runner les complète)', async () => {
    const tableGrants = await sql<{ object: string; privilege: string }[]>`
      select c.relname as object, a.privilege_type as privilege
      from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.relnamespace = 'public'::regnamespace and a.grantee = 'nuera_runner'::regrole
      order by 1, 2`;
    expect(tableGrants.map((row) => `${row.object}:${row.privilege}`).sort()).toEqual(
      [
        ...WORK_TABLES.flatMap(({ name }) => [`${name}:INSERT`, `${name}:SELECT`]),
        'projects:SELECT',
        'session_events_id_seq:USAGE',
        'space_settings:SELECT',
      ].sort(),
    );
    const columnGrants = await sql<{ table: string; column: string; privilege: string }[]>`
      select c.relname as table, att.attname as column, a.privilege_type as privilege
      from pg_attribute att
      join pg_class c on c.oid = att.attrelid
      cross join lateral aclexplode(att.attacl) a
      where c.relnamespace = 'public'::regnamespace and att.attnum > 0 and not att.attisdropped
        and a.grantee = 'nuera_runner'::regrole
      order by 1, 2, 3`;
    expect(columnGrants.map((row) => `${row.table}.${row.column}:${row.privilege}`).sort()).toEqual(
      [
        'app_settings.force_block_bypass_permissions:SELECT',
        'app_settings.id:SELECT',
        ...ENVIRONMENT_READ_COLUMNS.map((column) => `environments.${column}:SELECT`),
        ...ENVIRONMENT_WRITE_COLUMNS.map((column) => `environments.${column}:UPDATE`),
        ...PROJECT_WRITE_COLUMNS.map((column) => `projects.${column}:UPDATE`),
        ...WORK_TABLES.flatMap(({ name, columns }) => columns.map((column) => `${name}.${column.name}:UPDATE`)),
      ].sort(),
    );
    expect(
      await sql`select has_schema_privilege('nuera_runner', 'public', 'USAGE') as usage,
                       has_schema_privilege('nuera_runner', 'public', 'CREATE') as create,
                       has_function_privilege('nuera_runner', 'public.nuera_runner_environment_id()', 'EXECUTE') as identity`,
    ).toEqual([{ usage: true, create: false, identity: true }]);
    // Row-level security on exactly the tables the runner works on.
    const secured = await sql<{ relname: string }[]>`
      select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity order by 1`;
    expect(secured.map((row) => row.relname).sort()).toEqual([...RUNNER_TABLES].sort());
  });

  it('crée le rôle partagé une seule fois, même depuis deux bases en même temps (rôles du cluster)', async () => {
    const [block] = readFileSync(path.join(MIGRATIONS_FOLDER, '0004_runner_roles.sql'), 'utf8').split('--> statement-breakpoint');
    expect(block).toContain('CREATE ROLE "nuera_runner" NOLOGIN');
    const probe = block!.replaceAll('nuera_runner', ROLE_PROBE);
    await dropRole(admin, ROLE_PROBE);
    const elsewhere = adminClient();
    try {
      let firstCreated!: () => void;
      const created = new Promise<void>((resolve) => {
        firstCreated = resolve;
      });
      // The first creation stays uncommitted while the second one runs: the second waits on the
      // catalog's unique index, then gets unique_violation, which the block tolerates.
      const first = elsewhere.begin(async (tx) => {
        await tx.unsafe(probe);
        firstCreated();
        await tx`select pg_sleep(0.5)`;
      });
      await created;
      const second = sql.begin(async (tx) => {
        await tx.unsafe(probe);
      });
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      // Already there: nothing to do.
      await sql.unsafe(probe);
      expect(await admin`select rolcanlogin from pg_roles where rolname = ${ROLE_PROBE}`).toEqual([{ rolcanlogin: false }]);
    } finally {
      await elsewhere.end({ timeout: 5 });
      await dropRole(admin, ROLE_PROBE);
    }
  });

  it('tient sa disponibilité sous sa propre clé (runner pour le serveur par défaut)', async () => {
    const keyB = `runner:${member.environmentId}`;
    expect(await runnerB`select service from uptime_daily`).toEqual([{ service: keyB }]);
    expect(await runnerA`select service from uptime_daily`).toEqual([{ service: 'runner' }]);
    await runnerB`insert into uptime_daily (day, service, up_minutes) values ('2026-11-02', ${keyB}, 1)
                  on conflict (day, service) do update set up_minutes = uptime_daily.up_minutes + 1`;
    await runnerB`insert into uptime_daily (day, service, up_minutes) values ('2026-11-02', ${keyB}, 1)
                  on conflict (day, service) do update set up_minutes = uptime_daily.up_minutes + 1`;
    expect(await sql`select up_minutes from uptime_daily where service = ${keyB} and day = '2026-11-02'`).toEqual([{ up_minutes: 2 }]);
    await expect(runnerB`insert into uptime_daily (day, service) values ('2026-11-02', 'runner')`).rejects.toThrow(/row-level security/);
    await expect(runnerB`insert into uptime_daily (day, service) values ('2026-11-02', 'web')`).rejects.toThrow(/row-level security/);
  });

  it("ne lit que les réglages d'instance utiles au runner", async () => {
    expect(await runnerB`select force_block_bypass_permissions from app_settings`).toEqual([{ force_block_bypass_permissions: false }]);
    await expect(runnerB`select web_session_idle_hours from app_settings`).rejects.toThrow(/permission denied/);
    await expect(runnerB`select * from app_settings`).rejects.toThrow(/permission denied/);
    await expect(runnerB`update app_settings set force_block_bypass_permissions = false`).rejects.toThrow(/permission denied/);
  });

  it("n'a aucun accès aux comptes, invitations, sources, intégrations, variables, notifications ni au journal", async () => {
    for (const table of FORBIDDEN_TABLES) {
      await expect(runnerB.unsafe(`select count(*) from "${table}"`), table).rejects.toThrow(/permission denied/);
    }
    await expect(runnerB`update "user" set role = 'admin'`).rejects.toThrow(/permission denied/);
    await expect(runnerB`create table intrus (id int)`).rejects.toThrow(/permission denied/);
    await expect(runnerB`select count(*) from drizzle.__drizzle_migrations`).rejects.toThrow(/permission denied/);
  });

  it('un serveur retiré ne voit plus rien ; un serveur suspendu garde la lecture', async () => {
    await sql`update environments set status = 'suspended' where id = ${member.environmentId!}`;
    expect(await runnerB`select id from projects`).toEqual([{ id: ids.projectB }]);
    await sql`update environments set status = 'retired' where id = ${member.environmentId!}`;
    expect(await runnerB`select id from projects`).toEqual([]);
    expect(await runnerB`select id from environments`).toEqual([]);
    await sql`update environments set status = 'active' where id = ${member.environmentId!}`;
    expect(await runnerB`select id from projects`).toEqual([{ id: ids.projectB }]);
  });

  it("fonctionne avec Drizzle (colonnes explicites, updated_at automatique)", async () => {
    const runnerDb = drizzle(runnerB, { schema });
    expect(await runnerDb.select({ id: projects.id, slug: projects.slug }).from(projects)).toEqual([{ id: ids.projectB, slug: 'nuera-os' }]);
    await runnerDb.update(projects).set({ statusDetail: null }).where(eq(projects.id, ids.projectB));
    await runnerDb
      .update(environments)
      .set({ lastSeenAt: new Date(), runnerVersion: '1.2.4' })
      .where(eq(environments.id, member.environmentId!));
    const [created] = await runnerDb
      .insert(worktrees)
      .values({ projectId: ids.projectB, environmentId: member.environmentId!, name: 'docs', branch: 'docs', path: '/srv/dev/.worktrees/nuera-os/docs' })
      .returning();
    expect(created?.environmentId).toBe(member.environmentId);
    const [removed] = await runnerDb
      .update(worktrees)
      .set({ status: 'removed', removedAt: new Date() })
      .where(and(eq(worktrees.id, created!.id), eq(worktrees.environmentId, member.environmentId!)))
      .returning({ id: worktrees.id });
    expect(removed?.id).toBe(created!.id);
    expect(await pgFailure(runnerDb.delete(worktrees).where(eq(worktrees.id, created!.id)))).toMatch(/permission denied/);
    // Selecting every column of environments would read the token ciphertexts: refused.
    expect(await pgFailure(runnerDb.select().from(environments))).toMatch(/permission denied/);
  });

  it('le propriétaire des tables (web, serveur par défaut au DSN complet) voit tout', async () => {
    const [counts] = await sql<{ projects: string; sessions: string; environments: string }[]>`
      select (select count(*) from projects) as projects, (select count(*) from sessions) as sessions,
             (select count(*) from environments) as environments`;
    expect(counts).toEqual({ projects: '2', sessions: '2', environments: '2' });
  });
});
