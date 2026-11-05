import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
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

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** URL-safe identifier, also used for tmux names and default folder name. */
    slug: text('slug').notNull().unique(),
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
    /** Absolute path of the primary clone on VPS-3 (e.g. /srv/dev/nuera-os). */
    path: text('path').notNull().unique(),
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
    uniqueIndex('projects_github_full_name_active_idx')
      .on(t.githubFullName)
      .where(sql`${t.archivedAt} is null`),
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
    uniqueIndex('worktrees_project_name_active_idx')
      .on(t.projectId, t.name)
      .where(sql`${t.removedAt} is null`),
    uniqueIndex('worktrees_path_active_idx').on(t.path).where(sql`${t.removedAt} is null`),
  ],
);

export const commandRuns = pgTable(
  'command_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    worktreeId: uuid('worktree_id').references(() => worktrees.id, { onDelete: 'set null' }),
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
    startedAt: ts('started_at').defaultNow().notNull(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('command_runs_project_kind_idx').on(t.projectId, t.kind, t.startedAt)],
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
