import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { githubSources } from './github';
import { environments } from './tenancy';
import type {
  CommandKind,
  CommandRunDetails,
  CommandRunStatus,
  ProjectCommands,
  ProjectOptions,
  ProjectStatus,
  PullRequestState,
  SyncState,
  WorktreeStatus,
} from './types';

const ts = (name: string) => timestamp(name, { withTimezone: true });

/**
 * A GitHub repository cloned on one server. Its space and server never change (moving a project =
 * a new project, cloned again). Slug and path are physical, hence unique per server.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    /** Server holding the clone (immutable). Copied on every runtime row (worktrees, sessions…). */
    environmentId: uuid('environment_id').notNull(),
    /** GitHub source used for this repository (null = not bound yet). */
    githubSourceId: uuid('github_source_id'),
    createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    /** URL-safe identifier, also used for tmux names and default folder name (unique per server). */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** GitHub `owner/repo`. */
    githubFullName: text('github_full_name').notNull(),
    githubRepoId: bigint('github_repo_id', { mode: 'number' }),
    githubInstallationId: bigint('github_installation_id', { mode: 'number' }),
    cloneUrl: text('clone_url').notNull(),
    htmlUrl: text('html_url'),
    isPrivate: boolean('is_private').notNull().default(true),
    primaryLanguage: text('primary_language'),
    defaultBranch: text('default_branch').notNull().default('main'),
    /** Branch checked out in the primary clone. */
    currentBranch: text('current_branch'),
    /** Absolute path of the primary clone on its server (e.g. /srv/dev/nuera-os), unique per server. */
    path: text('path').notNull(),
    status: text('status').$type<ProjectStatus>().notNull().default('cloning'),
    statusDetail: text('status_detail'),
    isFavorite: boolean('is_favorite').notNull().default(false),
    commands: jsonb('commands').$type<ProjectCommands>().notNull().default({}),
    options: jsonb('options')
      .$type<ProjectOptions>()
      .notNull()
      .default({ installDeps: true, worktreePerSession: true, readClaudeMd: true }),
    syncState: text('sync_state').$type<SyncState>().notNull().default('unknown'),
    aheadBy: integer('ahead_by').notNull().default(0),
    behindBy: integer('behind_by').notNull().default(0),
    lastCommitSha: text('last_commit_sha'),
    lastCommitMessage: text('last_commit_message'),
    lastCommitAt: ts('last_commit_at'),
    claudeMdUpdatedAt: ts('claude_md_updated_at'),
    claudeMdCommitSha: text('claude_md_commit_sha'),
    lastFetchedAt: ts('last_fetched_at'),
    lastSyncedAt: ts('last_synced_at'),
    lastOpenedAt: ts('last_opened_at'),
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    // Target of the composite foreign keys (project_id, environment_id) of the runtime rows.
    unique('projects_id_environment_key').on(t.id, t.environmentId),
    // The server belongs to the project's space (and cannot be reassigned while it hosts projects).
    foreignKey({
      name: 'projects_env_space_fk',
      columns: [t.environmentId, t.spaceId],
      foreignColumns: [environments.id, environments.spaceId],
    }),
    // A project only uses a GitHub source of its own space (not checked while the source is null).
    foreignKey({
      name: 'projects_github_source_fk',
      columns: [t.githubSourceId, t.spaceId],
      foreignColumns: [githubSources.id, githubSources.spaceId],
    }),
    uniqueIndex('projects_environment_slug_idx').on(t.environmentId, t.slug),
    uniqueIndex('projects_environment_path_idx').on(t.environmentId, t.path),
    uniqueIndex('projects_environment_repo_active_idx')
      .on(t.environmentId, t.githubFullName)
      .where(sql`${t.archivedAt} is null`),
    index('projects_space_status_idx').on(t.spaceId, t.status),
    index('projects_environment_status_idx').on(t.environmentId, t.status),
    index('projects_status_idx').on(t.status),
  ],
);

export const projectEnvVars = pgTable(
  'project_env_vars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** AES-256-GCM ciphertext (see apps/web/src/server/security/crypto.ts). */
    valueEncrypted: text('value_encrypted').notNull(),
    isSecret: boolean('is_secret').notNull().default(true),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [uniqueIndex('project_env_vars_project_key_idx').on(t.projectId, t.key)],
);

export const worktrees = pgTable(
  'worktrees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Server of the project (composite foreign key below). */
    environmentId: uuid('environment_id').notNull(),
    /** Short name shown in the UI ("crm-core"). Primary clone uses the project slug. */
    name: text('name').notNull(),
    branch: text('branch').notNull(),
    baseBranch: text('base_branch'),
    path: text('path').notNull(),
    /** true for the primary clone (not a `git worktree add` checkout). */
    isPrimary: boolean('is_primary').notNull().default(false),
    status: text('status').$type<WorktreeStatus>().notNull().default('active'),
    createdAt: ts('created_at').defaultNow().notNull(),
    lastUsedAt: ts('last_used_at'),
    removedAt: ts('removed_at'),
  },
  (t) => [
    // Target of the composite foreign keys (worktree_id, environment_id) of sessions, operations and
    // command runs: a row only points to a worktree of its own server (migration 0005).
    unique('worktrees_id_environment_key').on(t.id, t.environmentId),
    foreignKey({
      name: 'worktrees_project_env_fk',
      columns: [t.projectId, t.environmentId],
      foreignColumns: [projects.id, projects.environmentId],
    }).onDelete('cascade'),
    uniqueIndex('worktrees_project_name_active_idx')
      .on(t.projectId, t.name)
      .where(sql`${t.removedAt} is null`),
    // A folder is unique on its server.
    uniqueIndex('worktrees_path_active_idx')
      .on(t.environmentId, t.path)
      .where(sql`${t.removedAt} is null`),
    index('worktrees_environment_status_idx').on(t.environmentId, t.status),
  ],
);

export const commandRuns = pgTable(
  'command_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Server of the project (composite foreign key below). */
    environmentId: uuid('environment_id').notNull(),
    /** Worktree of the same server (composite foreign key below). */
    worktreeId: uuid('worktree_id'),
    kind: text('kind').$type<CommandKind>().notNull(),
    command: text('command').notNull(),
    status: text('status').$type<CommandRunStatus>().notNull().default('running'),
    exitCode: integer('exit_code'),
    pid: integer('pid'),
    /** Port detected in the output of a dev server ("port 3000"). */
    port: integer('port'),
    /** Human summary parsed from the output when possible ("10 / 10 réussis"). */
    summary: text('summary'),
    /** Last ~64 KiB of output, kept for the UI after the process ends. */
    outputTail: text('output_tail'),
    /** Per-test results and failures (« Résultats des tests »), when the output could be parsed. */
    details: jsonb('details').$type<CommandRunDetails>(),
    /** Account that started the command. */
    actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    startedAt: ts('started_at').defaultNow().notNull(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    foreignKey({
      name: 'command_runs_project_env_fk',
      columns: [t.projectId, t.environmentId],
      foreignColumns: [projects.id, projects.environmentId],
    }).onDelete('cascade'),
    // ON DELETE SET NULL ("worktree_id") in the SQL of 0005: only the worktree is cleared, the
    // server (NOT NULL) stays. Drizzle has no column list for SET NULL.
    foreignKey({
      name: 'command_runs_worktree_env_fk',
      columns: [t.worktreeId, t.environmentId],
      foreignColumns: [worktrees.id, worktrees.environmentId],
    }).onDelete('set null'),
    index('command_runs_project_kind_idx').on(t.projectId, t.kind, t.startedAt),
    index('command_runs_environment_status_idx').on(t.environmentId, t.status),
  ],
);

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id'),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    headBranch: text('head_branch').notNull(),
    baseBranch: text('base_branch').notNull(),
    url: text('url').notNull(),
    state: text('state').$type<PullRequestState>().notNull().default('open'),
    draft: boolean('draft').notNull().default(false),
    /** Combined checks/status: success | failure | pending | none. */
    checksState: text('checks_state'),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    lastSyncedAt: ts('last_synced_at'),
  },
  (t) => [uniqueIndex('pull_requests_project_number_idx').on(t.projectId, t.number)],
);
