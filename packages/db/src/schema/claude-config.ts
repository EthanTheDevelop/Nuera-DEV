import { sql } from 'drizzle-orm';
import { bigserial, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { sessions } from './sessions';
import { spaces } from './tenancy';
import type {
  ClaudeConfigAudience,
  ClaudeConfigEnforcement,
  ClaudeConfigItemKind,
  ClaudeConfigVersionAction,
  ClaudePolicyEnvVar,
  ClaudePolicyRule,
  ClaudeProposalStatus,
  InstanceMcpConfig,
  InstanceMcpKind,
  McpAuthKind,
  McpStatus,
  McpTransport,
} from './types';

const ts = (name: string) => timestamp(name, { withTimezone: true });

/**
 * « Configuration Claude commune » (lot K1, migration 0007): rules, skills, MCP servers and the
 * permission policy shared by every account, server and session of the instance. Written by the
 * owner and administrators (web only); members read what applies to them and may propose a change.
 * The runner NEVER reads these tables: it fetches the effective configuration of its server from
 * the web (`/api/internal/claude-config`, token of the server) — no grant to `nuera_runner`.
 */

/** Markdown rules, applied before the project's CLAUDE.md (MULTICOMPTE §15). */
export const instanceRules = pgTable(
  'instance_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    position: integer('position').notNull().default(0),
    audience: text('audience').$type<ClaudeConfigAudience>().notNull().default('all'),
    enforcement: text('enforcement').$type<ClaudeConfigEnforcement>().notNull().default('default'),
    /** Reserved: tags of the projects the rule targets ([] = every project). Not applied in v1. */
    projectTags: jsonb('project_tags').$type<string[]>().notNull().default([]),
    version: integer('version').notNull().default(1),
    createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('instance_rules_position_idx').on(t.position)],
);

/** Skills (`SKILL.md` + text files), materialised by each runner in the `skills/` folder of its CLI. */
export const instanceSkills = pgTable(
  'instance_skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Folder name and `/name` of the skill: [a-z0-9][a-z0-9-]{0,63}, unique in the instance. */
    name: text('name').notNull(),
    description: text('description').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    audience: text('audience').$type<ClaudeConfigAudience>().notNull().default('all'),
    enforcement: text('enforcement').$type<ClaudeConfigEnforcement>().notNull().default('default'),
    /** Scripts (`.sh`, `.ps1`, `.py`…) accepted, written executable. Off unless an administrator ticks it. */
    allowScripts: boolean('allow_scripts').notNull().default(false),
    version: integer('version').notNull().default(1),
    /** sha256 of the files (paths, modes and contents): what the runners compare. */
    contentHash: text('content_hash').notNull(),
    totalBytes: integer('total_bytes').notNull().default(0),
    createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [uniqueIndex('instance_skills_name_idx').on(t.name)],
);

export const instanceSkillFiles = pgTable(
  'instance_skill_files',
  {
    skillId: uuid('skill_id')
      .notNull()
      .references(() => instanceSkills.id, { onDelete: 'cascade' }),
    /** Relative POSIX path inside the skill folder (`SKILL.md`, `references/x.md`). */
    path: text('path').notNull(),
    content: text('content').notNull(),
    executable: boolean('executable').notNull().default(false),
    sizeBytes: integer('size_bytes').notNull(),
  },
  (t) => [primaryKey({ columns: [t.skillId, t.path] })],
);

/**
 * MCP servers of the instance, added to the `--mcp-config` of every session whose account is in
 * the audience. Secret headers / tokens are encrypted (bound to the row) and only ever served by
 * the headers helper (`headersHelper: 'nuera'`), never written in a configuration file.
 */
export const instanceMcpServers = pgTable(
  'instance_mcp_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Name in Claude Code (`mcp__<name>__<tool>`), unique in the instance. */
    name: text('name').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    kind: text('kind').$type<InstanceMcpKind>().notNull().default('custom'),
    transport: text('transport').$type<McpTransport>().notNull(),
    url: text('url'),
    command: text('command'),
    args: jsonb('args').$type<string[]>().notNull().default([]),
    authKind: text('auth_kind').$type<McpAuthKind>().notNull().default('none'),
    secretsEncrypted: text('secrets_encrypted'),
    secretKeys: jsonb('secret_keys').$type<string[]>().notNull().default([]),
    config: jsonb('config').$type<InstanceMcpConfig>().notNull().default({}),
    audience: text('audience').$type<ClaudeConfigAudience>().notNull().default('all'),
    enforcement: text('enforcement').$type<ClaudeConfigEnforcement>().notNull().default('default'),
    enabled: boolean('enabled').notNull().default(true),
    status: text('status').$type<McpStatus>().notNull().default('unknown'),
    lastCheckedAt: ts('last_checked_at'),
    lastError: text('last_error'),
    /** Tools listed by the server at the last successful test (`tools/list`). */
    lastTools: jsonb('last_tools').$type<string[]>().notNull().default([]),
    /** Coolify: abilities read from those tools, and where they come from (`mcp_tools` = verified). */
    abilities: jsonb('abilities').$type<string[]>().notNull().default([]),
    abilitiesSource: text('abilities_source'),
    version: integer('version').notNull().default(1),
    createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [uniqueIndex('instance_mcp_servers_name_idx').on(t.name)],
);

/** Single row (`id = 'instance'`): permission rules, environment, model, global revision. */
export const instanceClaudePolicy = pgTable(
  'instance_claude_policy',
  {
    id: text('id').primaryKey().default('instance'),
    allowRules: jsonb('allow_rules').$type<ClaudePolicyRule[]>().notNull().default([]),
    askRules: jsonb('ask_rules').$type<ClaudePolicyRule[]>().notNull().default([]),
    denyRules: jsonb('deny_rules').$type<ClaudePolicyRule[]>().notNull().default([]),
    env: jsonb('env').$type<ClaudePolicyEnvVar[]>().notNull().default([]),
    defaultModel: text('default_model'),
    modelEnforcement: text('model_enforcement').$type<ClaudeConfigEnforcement>().notNull().default('default'),
    version: integer('version').notNull().default(0),
    /** Incremented by every change of the common configuration (any kind): « révision N ». */
    revision: integer('revision').notNull().default(0),
    updatedByUserId: text('updated_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [check('instance_claude_policy_single_row', sql`${t.id} = 'instance'`)],
);

/** Every version of every item (snapshots without any secret): diff, rollback, history. */
export const instanceConfigVersions = pgTable(
  'instance_config_versions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    itemKind: text('item_kind').$type<ClaudeConfigItemKind>().notNull(),
    itemId: text('item_id').notNull(),
    /** Label of the item at that version (title, name), kept after a deletion. */
    itemLabel: text('item_label').notNull(),
    version: integer('version').notNull(),
    action: text('action').$type<ClaudeConfigVersionAction>().notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    authorUserId: text('author_user_id').references(() => user.id, { onDelete: 'set null' }),
    authorLabel: text('author_label'),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [index('instance_config_versions_item_idx').on(t.itemKind, t.itemId, t.version), index('instance_config_versions_created_idx').on(t.createdAt)],
);

/** Rule or skill changes proposed by a member, applied only when an administrator approves them. */
export const instanceConfigProposals = pgTable(
  'instance_config_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<'rule' | 'skill'>().notNull(),
    /** Existing rule / skill the proposal changes (null: a new one). */
    targetId: uuid('target_id'),
    title: text('title').notNull(),
    /** Rule: `{ title, body }`; skill: `{ name, description, body }` (the SKILL.md body). */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    note: text('note'),
    status: text('status').$type<ClaudeProposalStatus>().notNull().default('pending'),
    authorUserId: text('author_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    reviewerUserId: text('reviewer_user_id').references(() => user.id, { onDelete: 'set null' }),
    reviewNote: text('review_note'),
    appliedItemId: uuid('applied_item_id'),
    createdAt: ts('created_at').defaultNow().notNull(),
    reviewedAt: ts('reviewed_at'),
  },
  (t) => [index('instance_config_proposals_status_idx').on(t.status, t.createdAt), index('instance_config_proposals_author_idx').on(t.authorUserId, t.createdAt)],
);

/** « Par défaut » items a space turned off (`rule:<id>`, `skill:<id>`, `mcp:<id>`, `perm:<id>`, `env:<id>`). */
export const spaceClaudeOverrides = pgTable(
  'space_claude_overrides',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    itemKey: text('item_key').notNull(),
    disabled: boolean('disabled').notNull().default(true),
    updatedByUserId: text('updated_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.itemKey] })],
);

/** What a session received at its last start / resume (shown in the Workspace). Written by the web only. */
export const sessionClaudeConfig = pgTable('session_claude_config', {
  sessionId: uuid('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spaces.id, { onDelete: 'cascade' }),
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
  appliedAt: ts('applied_at').defaultNow().notNull(),
});
