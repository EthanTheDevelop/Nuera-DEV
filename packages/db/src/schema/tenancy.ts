import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import type {
  EnvironmentCapabilities,
  EnvironmentConfigSource,
  EnvironmentStatus,
  InstanceRole,
  InvitationKind,
  PermissionMode,
  SessionBackend,
  SpaceKind,
  SpaceRole,
  ThemePreference,
} from './types';

/**
 * Accounts live in « espaces » (spaces) and work on « serveurs » (environments = runner instances).
 * Reference: docs/MULTICOMPTE.md §3. One personal space per account in v1; one active server per space.
 *
 * Row-level security and the grants of the restricted runner role (`nuera_runner`) are written in
 * SQL by migration 0004_runner_roles, never declared here, so drizzle-kit never diffs them.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** « Espace d'Ethan » */
    name: text('name').notNull(),
    kind: text('kind').$type<SpaceKind>().notNull().default('personal'),
    /**
     * Account owning a personal space. RESTRICT: an account is anonymised (`deleted_at`), never deleted
     * while it owns a space. Null only for a space created by migration 0002 to hold the data of a
     * database that had no account yet (adopted by the first owner).
     */
    ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'restrict' }),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    archivedAt: ts('archived_at'),
  },
  (t) => [uniqueIndex('spaces_personal_owner_idx').on(t.ownerUserId).where(sql`${t.kind} = 'personal'`)],
);

export const spaceMembers = pgTable(
  'space_members',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').$type<SpaceRole>().notNull().default('owner'),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.userId] }), index('space_members_user_idx').on(t.userId)],
);

/**
 * « Serveur » = one runner instance. The existing runner became the default server
 * (`is_default`, `config_source = 'env'`: URL and token come from RUNNER_URL / RUNNER_TOKEN, its
 * `token_hash` is filled by `migrate`). A server already used is never reassigned: it is retired.
 */
export const environments = pgTable(
  'environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** null = not assigned to a space yet. */
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'restrict' }),
    /** « VPS-3 » */
    name: text('name').notNull(),
    location: text('location'),
    status: text('status').$type<EnvironmentStatus>().notNull().default('pending'),
    configSource: text('config_source').$type<EnvironmentConfigSource>().notNull().default('db'),
    isDefault: boolean('is_default').notNull().default(false),
    /** Runner base URL (null for `config_source = 'env'`). */
    url: text('url'),
    /** AES-256-GCM ciphertext of the runner token (shown once, never sent back to a browser). */
    tokenEncrypted: text('token_encrypted'),
    /** sha256 hex of the runner token: how a runner finds its own row, how the web recognises its callbacks. */
    tokenHash: text('token_hash').unique(),
    /** Token being rotated in (accepted together with the current one until the runner uses it). */
    nextTokenEncrypted: text('next_token_encrypted'),
    nextTokenHash: text('next_token_hash').unique(),
    tokenRotatedAt: ts('token_rotated_at'),
    /** Restricted PostgreSQL login role of this runner (member of `nuera_runner`); null = full DSN. */
    dbRole: text('db_role').unique(),
    maxConcurrentSessions: integer('max_concurrent_sessions').notNull().default(4),
    /** Ceiling set by an administrator for `max_concurrent_sessions`. */
    maxConcurrentSessionsCap: integer('max_concurrent_sessions_cap').notNull().default(16),
    /** Memory ceiling per session process tree (MiB); null = no per-session ceiling. */
    sessionMemoryLimitMb: integer('session_memory_limit_mb'),
    /** Heartbeat of the runner (every 60 s). */
    lastSeenAt: ts('last_seen_at'),
    lastError: text('last_error'),
    runnerVersion: text('runner_version'),
    contractVersion: integer('contract_version'),
    backend: text('backend').$type<SessionBackend>(),
    capabilities: jsonb('capabilities').$type<EnvironmentCapabilities>().notNull().default({}),
    createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    // Target of the composite foreign key projects (environment_id, space_id).
    unique('environments_id_space_key').on(t.id, t.spaceId),
    uniqueIndex('environments_default_idx').on(sql`(true)`).where(sql`${t.isDefault}`),
    // v1: one server in use per space (retired servers do not count).
    uniqueIndex('environments_space_active_idx')
      .on(t.spaceId)
      .where(sql`${t.spaceId} is not null and ${t.status} <> 'retired'`),
  ],
);

/**
 * Invitation links (`/invitation/<jeton>`) and recovery links (`/recuperation/<jeton>`). Only the
 * sha256 hex of the token is stored; the link is shown once. Single use: consumed by a conditional
 * UPDATE (`accepted_at is null and revoked_at is null and expires_at > now()`).
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<InvitationKind>().notNull().default('invite'),
    /** Lower case. */
    email: text('email').notNull(),
    /** Role given by an invitation (`admin` | `member`); current role of the account for a recovery. */
    role: text('role').$type<InstanceRole>().notNull().default('member'),
    /** Target of a recovery, or the account created by the invitation. */
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    /** `pending` server pre-assigned to the space the invitation creates. */
    environmentId: uuid('environment_id').references(() => environments.id, { onDelete: 'set null' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    acceptedAt: ts('accepted_at'),
    /** Second factor enrolled: the link can no longer resume the activation. */
    completedAt: ts('completed_at'),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('invitations_pending_email_idx')
      .on(t.kind, t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
  ],
);

/** Settings of a space (set by its owner). The instance may force the bypass block on top. */
export const spaceSettings = pgTable('space_settings', {
  spaceId: uuid('space_id')
    .primaryKey()
    .references(() => spaces.id, { onDelete: 'cascade' }),
  /** null = « Défaut du CLI » */
  defaultModel: text('default_model'),
  defaultEffort: text('default_effort'),
  defaultPermissionMode: text('default_permission_mode').$type<PermissionMode>().notNull().default('manual'),
  /** « Bloquer le mode sans autorisation » (effective = instance OR space). */
  blockBypassPermissions: boolean('block_bypass_permissions').notNull().default(true),
  /** How long the PermissionRequest hook waits for a decision taken in Nuera Dev. */
  permissionWaitSeconds: integer('permission_wait_seconds').notNull().default(120),
  remoteControlByDefault: boolean('remote_control_by_default').notNull().default(false),
  worktreeStaleDays: integer('worktree_stale_days').notNull().default(30),
  updatedAt: ts('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

/** Preferences of one account. */
export const userPreferences = pgTable('user_preferences', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  theme: text('theme').$type<ThemePreference>().notNull().default('light'),
  locale: text('locale').notNull().default('fr'),
  /** Git identity of commits made for this account; null = name and e-mail of the account. */
  gitAuthorName: text('git_author_name'),
  gitAuthorEmail: text('git_author_email'),
  updatedAt: ts('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});
