import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from './index';
import { runMigrations } from './migrate';
import { seedEnvironment, seedMember, seedOwner, type SeededAccount } from './test/fixtures';
import { adminClient, databaseUrl, dropDatabase, pgAvailable, pgFailure, recreateDatabase, testName } from './test/pg';

/**
 * Database guarantees of the multi-account model (docs/MULTICOMPTE.md §3): physical uniques per
 * server, composite foreign keys refusing a row that crosses spaces or servers, one owner, one
 * personal space per account, one server in use per space, per-recipient notifications.
 */

const DB_NAME = testName('constraints');
const available = await pgAvailable('constraints.test');

describe.skipIf(!available)('contraintes du modèle multi-comptes', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let db: Database;
  let owner: SeededAccount;
  let member: SeededAccount;
  let lonely: SeededAccount;
  const url = databaseUrl(DB_NAME);

  async function insertProject(input: { spaceId: string; environmentId: string; slug?: string; path?: string; repo?: string; archived?: boolean; githubSourceId?: string | null }) {
    const id = randomUUID();
    const slug = input.slug ?? `p-${id.slice(0, 8)}`;
    await sql`
      insert into projects (id, space_id, environment_id, github_source_id, slug, name, github_full_name, clone_url, path, archived_at)
      values (${id}, ${input.spaceId}, ${input.environmentId}, ${input.githubSourceId ?? null}, ${slug}, ${slug},
              ${input.repo ?? `nuera-studio/${slug}`}, 'https://github.com/x/y.git', ${input.path ?? `/srv/dev/${slug}`},
              ${input.archived ? new Date() : null})`;
    return id;
  }

  beforeAll(async () => {
    admin = adminClient();
    await recreateDatabase(admin, DB_NAME);
    await runMigrations(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    db = createDb(url, { max: 2 });
    owner = await seedOwner(db, { email: 'owner@example.test', name: 'Ethan' });
    member = await seedMember(db, { email: 'camille@example.test', name: 'Camille', environment: { name: 'Serveur de Camille' } });
    lonely = await seedMember(db, { email: 'alex@example.test', name: 'Alex', environment: false });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await db?.$client.end({ timeout: 5 });
    if (admin) {
      await dropDatabase(admin, DB_NAME);
      await admin.end({ timeout: 5 });
    }
  });

  it("les fixtures reprennent le serveur par défaut laissé libre par la migration", async () => {
    const rows = await sql`select id, space_id, status, is_default, config_source, name from environments order by is_default desc`;
    expect(rows).toEqual([
      { id: owner.environmentId, space_id: owner.spaceId, status: 'active', is_default: true, config_source: 'env', name: 'VPS-3' },
      { id: member.environmentId, space_id: member.spaceId, status: 'active', is_default: false, config_source: 'db', name: 'Serveur de Camille' },
    ]);
    expect(lonely.environmentId).toBeNull();
    const relational = await db.query.spaces.findFirst({
      where: (spaces, { eq }) => eq(spaces.id, owner.spaceId),
      with: { owner: true, members: true, settings: true, environments: true },
    });
    expect(relational?.owner?.email).toBe('owner@example.test');
    expect(relational?.members.map((m) => [m.userId, m.role])).toEqual([[owner.userId, 'owner']]);
    expect(relational?.settings?.blockBypassPermissions).toBe(true);
    expect(relational?.environments.map((e) => e.id)).toEqual([owner.environmentId]);
  });

  it("slug, dossier et dépôt actif sont uniques par serveur, pas pour toute l'instance", async () => {
    await insertProject({ spaceId: owner.spaceId, environmentId: owner.environmentId!, slug: 'nuera-os', path: '/srv/dev/nuera-os', repo: 'nuera-studio/nuera-os' });
    // Same folder, slug and repository on another server: accepted.
    await insertProject({ spaceId: member.spaceId, environmentId: member.environmentId!, slug: 'nuera-os', path: '/srv/dev/nuera-os', repo: 'nuera-studio/nuera-os' });
    await expect(
      insertProject({ spaceId: owner.spaceId, environmentId: owner.environmentId!, slug: 'nuera-os', path: '/srv/dev/autre', repo: 'nuera-studio/autre' }),
    ).rejects.toThrow(/projects_environment_slug_idx/);
    await expect(
      insertProject({ spaceId: owner.spaceId, environmentId: owner.environmentId!, slug: 'autre', path: '/srv/dev/nuera-os', repo: 'nuera-studio/autre' }),
    ).rejects.toThrow(/projects_environment_path_idx/);
    await expect(
      insertProject({ spaceId: owner.spaceId, environmentId: owner.environmentId!, slug: 'copie', path: '/srv/dev/copie', repo: 'nuera-studio/nuera-os' }),
    ).rejects.toThrow(/projects_environment_repo_active_idx/);
    // An archived project of the same repository does not count.
    await insertProject({ spaceId: owner.spaceId, environmentId: owner.environmentId!, slug: 'ancien', path: '/srv/dev/ancien', repo: 'nuera-studio/nuera-os', archived: true });
  });

  it("refuse un projet sur le serveur d'un autre espace", async () => {
    await expect(insertProject({ spaceId: owner.spaceId, environmentId: member.environmentId! })).rejects.toThrow(/projects_env_space_fk/);
    await expect(insertProject({ spaceId: lonely.spaceId, environmentId: owner.environmentId! })).rejects.toThrow(/projects_env_space_fk/);
  });

  it("refuse une source GitHub d'un autre espace", async () => {
    const [source] = await sql<{ id: string }[]>`
      insert into github_sources (space_id, app_id, owner_login) values (${member.spaceId}, 4242, 'camille') returning id`;
    await expect(
      insertProject({ spaceId: owner.spaceId, environmentId: owner.environmentId!, githubSourceId: source!.id }),
    ).rejects.toThrow(/projects_github_source_fk/);
    await insertProject({ spaceId: member.spaceId, environmentId: member.environmentId!, githubSourceId: source!.id });
    // An app id is unique across the instance.
    await expect(sql`insert into github_sources (space_id, app_id) values (${owner.spaceId}, 4242)`).rejects.toThrow(/github_sources_app_id_idx/);
    // A source used by a project cannot be deleted.
    await expect(sql`delete from github_sources where id = ${source!.id}`).rejects.toThrow(/projects_github_source_fk/);
  });

  it('les lignes de travail portent le serveur de leur projet (clés étrangères composites)', async () => {
    const projectId = await insertProject({ spaceId: owner.spaceId, environmentId: owner.environmentId! });
    const foreign = member.environmentId!;
    await expect(
      sql`insert into worktrees (project_id, environment_id, name, branch, path) values (${projectId}, ${foreign}, 'w', 'main', '/srv/dev/w')`,
    ).rejects.toThrow(/worktrees_project_env_fk/);
    await expect(
      sql`insert into sessions (id, project_id, environment_id, title) values (${randomUUID()}, ${projectId}, ${foreign}, 'S')`,
    ).rejects.toThrow(/sessions_project_env_fk/);
    await expect(
      sql`insert into command_runs (project_id, environment_id, kind, command) values (${projectId}, ${foreign}, 'test', 'npm test')`,
    ).rejects.toThrow(/command_runs_project_env_fk/);
    await expect(
      sql`insert into operations (kind, project_id, environment_id) values ('pull', ${projectId}, ${foreign})`,
    ).rejects.toThrow(/operations_project_env_fk/);
    const sessionId = randomUUID();
    await sql`insert into sessions (id, project_id, environment_id, title) values (${sessionId}, ${projectId}, ${owner.environmentId!}, 'S')`;
    await expect(sql`update sessions set environment_id = ${foreign} where id = ${sessionId}`).rejects.toThrow(/sessions_project_env_fk/);
    // The server of a project never changes while rows depend on it.
    await expect(sql`update projects set environment_id = ${foreign} where id = ${projectId}`).rejects.toThrow(/_fk/);
    // An operation without project only names its server.
    await sql`insert into operations (kind, environment_id) values ('maintenance', ${foreign})`;
    await expect(sql`insert into operations (kind) values ('maintenance')`).rejects.toThrow(/environment_id/);
  });

  it("une ligne ne désigne qu'un worktree ou une session de son serveur (0005) ; leur suppression efface seulement le lien", async () => {
    const own = owner.environmentId!;
    const foreign = member.environmentId!;
    const projectA = await insertProject({ spaceId: owner.spaceId, environmentId: own });
    const projectB = await insertProject({ spaceId: member.spaceId, environmentId: foreign });
    const [worktreeA] = await sql<{ id: string }[]>`
      insert into worktrees (project_id, environment_id, name, branch, path) values (${projectA}, ${own}, 'a', 'main', ${`/srv/dev/${projectA}`})
      returning id`;
    const [worktreeB] = await sql<{ id: string }[]>`
      insert into worktrees (project_id, environment_id, name, branch, path) values (${projectB}, ${foreign}, 'b', 'main', ${`/srv/dev/${projectB}`})
      returning id`;
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    await sql`insert into sessions (id, project_id, environment_id, worktree_id, title) values (${sessionA}, ${projectA}, ${own}, ${worktreeA!.id}, 'A')`;
    await sql`insert into sessions (id, project_id, environment_id, worktree_id, title) values (${sessionB}, ${projectB}, ${foreign}, ${worktreeB!.id}, 'B')`;
    // Another server's worktree or session: refused for every writer (the check ignores row-level security).
    await expect(sql`update sessions set worktree_id = ${worktreeA!.id} where id = ${sessionB}`).rejects.toThrow(/sessions_worktree_env_fk/);
    await expect(
      sql`insert into sessions (id, project_id, environment_id, worktree_id, title) values (${randomUUID()}, ${projectB}, ${foreign}, ${worktreeA!.id}, 'X')`,
    ).rejects.toThrow(/sessions_worktree_env_fk/);
    await expect(
      sql`insert into command_runs (project_id, environment_id, worktree_id, kind, command) values (${projectB}, ${foreign}, ${worktreeA!.id}, 'test', 'npm test')`,
    ).rejects.toThrow(/command_runs_worktree_env_fk/);
    await expect(
      sql`insert into operations (kind, project_id, environment_id, worktree_id) values ('pull', ${projectB}, ${foreign}, ${worktreeA!.id})`,
    ).rejects.toThrow(/operations_worktree_env_fk/);
    await expect(
      sql`insert into operations (kind, environment_id, session_id) values ('maintenance', ${foreign}, ${sessionA})`,
    ).rejects.toThrow(/operations_session_env_fk/);
    // An unknown id is refused the same way.
    await expect(sql`update sessions set worktree_id = ${randomUUID()} where id = ${sessionB}`).rejects.toThrow(/sessions_worktree_env_fk/);
    // Its own server: accepted.
    const [run] = await sql<{ id: string }[]>`
      insert into command_runs (project_id, environment_id, worktree_id, kind, command) values (${projectB}, ${foreign}, ${worktreeB!.id}, 'test', 'npm test')
      returning id`;
    const [operation] = await sql<{ id: string }[]>`
      insert into operations (kind, project_id, environment_id, worktree_id, session_id) values ('pull', ${projectB}, ${foreign}, ${worktreeB!.id}, ${sessionB})
      returning id`;
    // Deleting the worktree or the session clears the reference only: the row keeps its server.
    await sql`delete from sessions where id = ${sessionB}`;
    expect(await sql`select session_id, worktree_id, environment_id from operations where id = ${operation!.id}`).toEqual([
      { session_id: null, worktree_id: worktreeB!.id, environment_id: foreign },
    ]);
    await sql`delete from worktrees where id = ${worktreeB!.id}`;
    expect(await sql`select worktree_id, environment_id from operations where id = ${operation!.id}`).toEqual([{ worktree_id: null, environment_id: foreign }]);
    expect(await sql`select worktree_id, environment_id from command_runs where id = ${run!.id}`).toEqual([{ worktree_id: null, environment_id: foreign }]);
    await sql`delete from worktrees where id = ${worktreeA!.id}`;
    expect(await sql`select worktree_id, environment_id from sessions where id = ${sessionA}`).toEqual([{ worktree_id: null, environment_id: own }]);
  });

  it("un dossier de worktree actif est unique sur son serveur", async () => {
    const mine = await insertProject({ spaceId: owner.spaceId, environmentId: owner.environmentId! });
    const theirs = await insertProject({ spaceId: member.spaceId, environmentId: member.environmentId! });
    const path = '/srv/dev/.worktrees/x/crm';
    await sql`insert into worktrees (project_id, environment_id, name, branch, path) values (${mine}, ${owner.environmentId!}, 'crm', 'crm', ${path})`;
    await sql`insert into worktrees (project_id, environment_id, name, branch, path) values (${theirs}, ${member.environmentId!}, 'crm', 'crm', ${path})`;
    await expect(
      sql`insert into worktrees (project_id, environment_id, name, branch, path) values (${mine}, ${owner.environmentId!}, 'crm2', 'crm2', ${path})`,
    ).rejects.toThrow(/worktrees_path_active_idx/);
    await sql`update worktrees set removed_at = now(), status = 'removed' where project_id = ${mine}`;
    await sql`insert into worktrees (project_id, environment_id, name, branch, path) values (${mine}, ${owner.environmentId!}, 'crm', 'crm', ${path})`;
  });

  it('un compte a un seul espace personnel ; un espace, un seul serveur en service', async () => {
    await expect(sql`insert into spaces (name, owner_user_id) values ('Second', ${owner.userId})`).rejects.toThrow(/spaces_personal_owner_idx/);
    await sql`insert into spaces (name, kind, owner_user_id) values ('Partagé', 'shared', ${owner.userId})`;
    await expect(pgFailure(seedEnvironment(db, { spaceId: owner.spaceId }))).resolves.toMatch(/environments_space_active_idx/);
    // A retired server leaves room for a new one.
    const retired = await seedEnvironment(db, { spaceId: lonely.spaceId, status: 'retired' });
    const fresh = await seedEnvironment(db, { spaceId: lonely.spaceId });
    expect(fresh).not.toBe(retired);
    await expect(pgFailure(seedEnvironment(db, { spaceId: null, isDefault: true }))).resolves.toMatch(/environments_default_idx/);
    await sql`update environments set token_hash = 'h1', db_role = 'nuera_env_aaaaaaaa' where id = ${fresh}`;
    await expect(pgFailure(seedEnvironment(db, { spaceId: null, tokenHash: 'h1' }))).resolves.toMatch(/environments_token_hash_unique/);
    await expect(pgFailure(seedEnvironment(db, { spaceId: null, dbRole: 'nuera_env_aaaaaaaa' }))).resolves.toMatch(/environments_db_role_unique/);
  });

  it("un serveur qui héberge des projets n'est jamais réattribué ; un compte qui possède un espace n'est pas supprimé", async () => {
    const target = await seedMember(db, { email: 'cible@example.test', environment: false });
    await expect(sql`update environments set space_id = ${target.spaceId} where id = ${owner.environmentId!}`).rejects.toThrow(
      /projects_env_space_fk/,
    );
    await expect(sql`delete from "user" where id = ${owner.userId}`).rejects.toThrow(/spaces_owner_user_id_user_id_fk/);
  });

  it('une notification non lue par destinataire et par clé', async () => {
    await sql`insert into notifications (user_id, space_id, kind, title, dedup_key) values (${owner.userId}, ${owner.spaceId}, 'server', 'A', 'claude:auth')`;
    await expect(
      sql`insert into notifications (user_id, kind, title, dedup_key) values (${owner.userId}, 'server', 'B', 'claude:auth')`,
    ).rejects.toThrow(/notifications_user_dedup_unread_idx/);
    await sql`insert into notifications (user_id, space_id, kind, title, dedup_key) values (${member.userId}, ${member.spaceId}, 'server', 'A', 'claude:auth')`;
    await sql`update notifications set read_at = now() where user_id = ${owner.userId}`;
    await sql`insert into notifications (user_id, kind, title, dedup_key) values (${owner.userId}, 'server', 'C', 'claude:auth')`;
    // Upsert target used by the web.
    await sql`
      insert into notifications (user_id, kind, title, dedup_key) values (${owner.userId}, 'server', 'D', 'claude:auth')
      on conflict (user_id, dedup_key) where read_at is null and dedup_key is not null do update set title = excluded.title`;
    const rows = await sql`select title from notifications where user_id = ${owner.userId} and read_at is null`;
    expect(rows).toEqual([{ title: 'D' }]);
    await expect(sql`insert into notifications (kind, title) values ('server', 'Sans destinataire')`).rejects.toThrow(/user_id/);
  });

  it('un abonnement push par compte et par navigateur', async () => {
    const endpoint = 'https://push.example.test/abc';
    await sql`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values (${owner.userId}, ${endpoint}, 'p', 'a')`;
    await sql`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values (${member.userId}, ${endpoint}, 'p', 'a')`;
    await expect(
      sql`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values (${owner.userId}, ${endpoint}, 'p', 'a')`,
    ).rejects.toThrow(/push_subscriptions_user_endpoint_idx/);
  });

  it("une invitation en attente par adresse ; un jeton ne sert qu'une fois", async () => {
    const expires = new Date(Date.now() + 3_600_000);
    await sql`insert into invitations (email, token_hash, expires_at) values ('nouveau@example.test', 'hash-1', ${expires})`;
    await expect(
      sql`insert into invitations (email, token_hash, expires_at) values ('nouveau@example.test', 'hash-2', ${expires})`,
    ).rejects.toThrow(/invitations_pending_email_idx/);
    await sql`insert into invitations (kind, email, token_hash, expires_at) values ('recovery', 'nouveau@example.test', 'hash-3', ${expires})`;
    await sql`update invitations set revoked_at = now() where token_hash = 'hash-1'`;
    await sql`insert into invitations (email, token_hash, expires_at) values ('nouveau@example.test', 'hash-4', ${expires})`;
    await expect(
      sql`insert into invitations (email, token_hash, expires_at) values ('autre@example.test', 'hash-4', ${expires})`,
    ).rejects.toThrow(/invitations_token_hash_unique/);
  });

  it('Coolify, Figma et le registre MCP sont propres à chaque espace', async () => {
    await sql`insert into integrations (space_id, kind) values (${owner.spaceId}, 'coolify')`;
    await sql`insert into integrations (space_id, kind) values (${member.spaceId}, 'coolify')`;
    await expect(sql`insert into integrations (space_id, kind) values (${owner.spaceId}, 'coolify')`).rejects.toThrow(
      /integrations_space_kind_idx/,
    );
    await expect(sql`insert into integrations (kind) values ('figma')`).rejects.toThrow(/space_id/);
    await sql`insert into mcp_servers (space_id, name, label, transport) values (${owner.spaceId}, 'figma', 'Figma', 'http')`;
    await sql`insert into mcp_servers (space_id, name, label, transport) values (${member.spaceId}, 'figma', 'Figma', 'http')`;
    await expect(
      sql`insert into mcp_servers (space_id, name, label, transport) values (${owner.spaceId}, 'figma', 'Figma', 'http')`,
    ).rejects.toThrow(/mcp_servers_space_name_idx/);
  });
});
