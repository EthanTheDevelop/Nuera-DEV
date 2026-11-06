import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { projects, worktrees } from './projects';
import { sessions } from './sessions';
import { spaces } from './tenancy';
import type {
  NotificationKind,
  OperationError,
  OperationKind,
  OperationStatus,
  OperationStep,
  PermissionMode,
  Severity,
  ThemePreference,
} from './types';

const ts = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Instance settings, single row (id = 1), changed by the owner and administrators
 * (docs/MULTICOMPTE.md §8). The other settings moved to `environments` (server), `space_settings`
 * (space) and `user_preferences` (account): their old columns stay in the table, deprecated and
 * never read again, until a later migration drops them.
 */
export const appSettings = pgTable(
  'app_settings',
  {
    id: integer('id').primaryKey().default(1),
    /** « Un accès expire après 12 h d'inactivité, et au plus tard après 30 jours. » */
    webSessionIdleHours: integer('web_session_idle_hours').notNull().default(12),
    webSessionMaxDays: integer('web_session_max_days').notNull().default(30),
    /** Validity of an invitation link (hours). */
    invitationTtlHours: integer('invitation_ttl_hours').notNull().default(48),
    /** Forces « Bloquer le mode sans autorisation » in every space (effective = instance OR space). */
    forceBlockBypassPermissions: boolean('force_block_bypass_permissions').notNull().default(false),
    /** @deprecated Moved to `environments.max_concurrent_sessions`. Never read. */
    maxConcurrentSessions: integer('max_concurrent_sessions').notNull().default(4),
    /** @deprecated Moved to `space_settings.default_model`. Never read. */
    defaultModel: text('default_model'),
    /** @deprecated Moved to `space_settings.default_effort`. Never read. */
    defaultEffort: text('default_effort'),
    /** @deprecated Moved to `space_settings.default_permission_mode`. Never read. */
    defaultPermissionMode: text('default_permission_mode').$type<PermissionMode>().notNull().default('manual'),
    /** @deprecated Moved to `space_settings.block_bypass_permissions`. Never read. */
    blockBypassPermissions: boolean('block_bypass_permissions').notNull().default(true),
    /** @deprecated Moved to `space_settings.permission_wait_seconds`. Never read. */
    permissionWaitSeconds: integer('permission_wait_seconds').notNull().default(120),
    /** @deprecated Moved to `space_settings.remote_control_by_default`. Never read. */
    remoteControlByDefault: boolean('remote_control_by_default').notNull().default(false),
    /** @deprecated Had no effect (the runner uses NUERA_PROJECTS_ROOT). Never read. */
    projectsRoot: text('projects_root'),
    /** @deprecated Moved to `environments.name`. Never read. */
    serverName: text('server_name').notNull().default('VPS-3'),
    /** @deprecated Moved to `environments.location`. Never read. */
    serverLocation: text('server_location'),
    /** @deprecated Moved to `environments.session_memory_limit_mb`. Never read. */
    sessionMemoryLimitMb: integer('session_memory_limit_mb'),
    /** @deprecated Moved to `space_settings.worktree_stale_days`. Never read. */
    worktreeStaleDays: integer('worktree_stale_days').notNull().default(30),
    /** @deprecated Moved to `user_preferences.theme`. Never read. */
    theme: text('theme').$type<ThemePreference>().notNull().default('light'),
    /** @deprecated Moved to `user_preferences.locale`. Never read. */
    locale: text('locale').notNull().default('fr'),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [check('app_settings_singleton', sql`${t.id} = 1`)],
);

/** Long-running operations with progress and a journal (clone, pull, push, commit, PR…). */
export const operations = pgTable(
  'operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<OperationKind>().notNull(),
    status: text('status').$type<OperationStatus>().notNull().default('queued'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** Server running the operation (that of its project: composite foreign key below). */
    environmentId: uuid('environment_id').notNull(),
    /** Worktree and session of the same server (composite foreign keys below). */
    worktreeId: uuid('worktree_id'),
    sessionId: uuid('session_id'),
    title: text('title'),
    progress: integer('progress'),
    steps: jsonb('steps').$type<OperationStep[]>().notNull().default([]),
    /** Journal (last ~64 KiB). */
    log: text('log').notNull().default(''),
    error: jsonb('error').$type<OperationError>(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').defaultNow().notNull(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    // Not checked for an operation without project (MATCH SIMPLE).
    foreignKey({
      name: 'operations_project_env_fk',
      columns: [t.projectId, t.environmentId],
      foreignColumns: [projects.id, projects.environmentId],
    }).onDelete('cascade'),
    // ON DELETE SET NULL ("worktree_id") / ("session_id") in the SQL of 0005: only the reference is
    // cleared, the server (NOT NULL) stays. Drizzle has no column list for SET NULL.
    foreignKey({
      name: 'operations_worktree_env_fk',
      columns: [t.worktreeId, t.environmentId],
      foreignColumns: [worktrees.id, worktrees.environmentId],
    }).onDelete('set null'),
    foreignKey({
      name: 'operations_session_env_fk',
      columns: [t.sessionId, t.environmentId],
      foreignColumns: [sessions.id, sessions.environmentId],
    }).onDelete('set null'),
    index('operations_project_idx').on(t.projectId, t.createdAt),
    index('operations_status_idx').on(t.status),
    index('operations_environment_status_idx').on(t.environmentId, t.status),
  ],
);

/** One row per recipient. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Recipient. */
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Space the notification is about; null for an instance alert. */
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<NotificationKind>().notNull(),
    severity: text('severity').$type<Severity>().notNull().default('info'),
    title: text('title').notNull(),
    body: text('body'),
    href: text('href'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    /** Dedup key: one unread notification per recipient and key (e.g. `permission:<id>`). */
    dedupKey: text('dedup_key'),
    readAt: ts('read_at'),
    pushedAt: ts('pushed_at'),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('notifications_created_idx').on(t.createdAt),
    index('notifications_unread_idx').on(t.readAt),
    // Target of INSERT … ON CONFLICT (user_id, dedup_key) WHERE read_at IS NULL AND dedup_key IS NOT NULL.
    uniqueIndex('notifications_user_dedup_unread_idx')
      .on(t.userId, t.dedupKey)
      .where(sql`${t.readAt} is null and ${t.dedupKey} is not null`),
    index('notifications_user_read_created_idx').on(t.userId, t.readAt, t.createdAt),
  ],
);

/** Web Push subscriptions, per account: one browser may hold the subscriptions of several accounts. */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    deviceLabel: text('device_label'),
    /** Web access (Better Auth session id) that registered the subscription — informative, no foreign key. */
    authSessionId: text('auth_session_id'),
    createdAt: ts('created_at').defaultNow().notNull(),
    lastUsedAt: ts('last_used_at'),
  },
  // Target of INSERT … ON CONFLICT (user_id, endpoint).
  (t) => [uniqueIndex('push_subscriptions_user_endpoint_idx').on(t.userId, t.endpoint)],
);

/** Security journal and sensitive actions. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    /** 'user' | 'system' | 'runner' */
    actorKind: text('actor_kind').notNull().default('user'),
    /** Dotted action name: auth.sign_in, auth.2fa_enabled, session.revoked, permission.allowed_always, git.push… */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** Short French summary shown in « Journal de sécurité ». */
    summary: text('summary').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    // No foreign keys on the four columns below: journal rows survive deletions.
    /** Space of a business event (projects, sessions, Git, integrations…); null for account and instance events. */
    spaceId: uuid('space_id'),
    /** Server the event happened on. */
    environmentId: uuid('environment_id'),
    /** Account the event concerns (sign-in attempt on its e-mail, an administrator's action on it…). */
    subjectUserId: text('subject_user_id'),
    /** E-mail of the author when the event was written (kept after the account is anonymised). */
    actorLabel: text('actor_label'),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt),
    index('audit_log_action_idx').on(t.action),
    index('audit_log_space_idx').on(t.spaceId, t.id),
    index('audit_log_actor_idx').on(t.actorUserId, t.id),
    index('audit_log_subject_idx').on(t.subjectUserId, t.id),
  ],
);

/**
 * Availability per day and per service, fed by the runner heartbeat (one tick per minute).
 * expected minutes for "today" are computed at read time.
 * Service key of a server: `runner` for the default server (history kept), `runner:<environmentId>`
 * for the others (`uptimeServiceKey()` of `@nuera/shared/runner`).
 */
export const uptimeDaily = pgTable(
  'uptime_daily',
  {
    day: date('day').notNull(),
    /** 'runner' | 'runner:<environmentId>' | 'web' | 'claude' */
    service: text('service').notNull(),
    upMinutes: integer('up_minutes').notNull().default(0),
    /** Minutes the service was expected up (filled when the day is closed or a gap is detected). */
    expectedMinutes: integer('expected_minutes').notNull().default(0),
    incidents: jsonb('incidents')
      .$type<Array<{ start: string; end: string | null; reason: string }>>()
      .notNull()
      .default([]),
    lastBeatAt: ts('last_beat_at'),
  },
  (t) => [primaryKey({ columns: [t.day, t.service] })],
);
