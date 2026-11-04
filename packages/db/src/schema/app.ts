import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { projects, worktrees } from './projects';
import { sessions } from './sessions';
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

/** Single-row settings table (id = 1). */
export const appSettings = pgTable(
  'app_settings',
  {
    id: integer('id').primaryKey().default(1),
    /** "2 sessions actives sur 4 autorisées" */
    maxConcurrentSessions: integer('max_concurrent_sessions').notNull().default(4),
    /** null = « Défaut du CLI » */
    defaultModel: text('default_model'),
    defaultEffort: text('default_effort'),
    defaultPermissionMode: text('default_permission_mode').$type<PermissionMode>().notNull().default('manual'),
    /** « Bloquer le mode sans autorisation » */
    blockBypassPermissions: boolean('block_bypass_permissions').notNull().default(true),
    /** How long the PermissionRequest hook waits for a decision taken in Nuera Dev before falling back to the terminal. */
    permissionWaitSeconds: integer('permission_wait_seconds').notNull().default(120),
    remoteControlByDefault: boolean('remote_control_by_default').notNull().default(false),
    /** « Un accès expire après 12 h d'inactivité, et au plus tard après 30 jours. » */
    webSessionIdleHours: integer('web_session_idle_hours').notNull().default(12),
    webSessionMaxDays: integer('web_session_max_days').notNull().default(30),
    /** Root folder of clones on VPS-3 (« Destination sur VPS-3 »). null = NUERA_PROJECTS_ROOT */
    projectsRoot: text('projects_root'),
    serverName: text('server_name').notNull().default('VPS-3'),
    serverLocation: text('server_location'),
    /** Memory ceiling per session process tree (MiB); null = no per-session ceiling. */
    sessionMemoryLimitMb: integer('session_memory_limit_mb'),
    worktreeStaleDays: integer('worktree_stale_days').notNull().default(30),
    theme: text('theme').$type<ThemePreference>().notNull().default('light'),
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
    worktreeId: uuid('worktree_id').references(() => worktrees.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
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
    index('operations_project_idx').on(t.projectId, t.createdAt),
    index('operations_status_idx').on(t.status),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<NotificationKind>().notNull(),
    severity: text('severity').$type<Severity>().notNull().default('info'),
    title: text('title').notNull(),
    body: text('body'),
    href: text('href'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    /** Dedup key: one unread notification per key (e.g. `permission:<id>`). */
    dedupKey: text('dedup_key'),
    readAt: ts('read_at'),
    pushedAt: ts('pushed_at'),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [index('notifications_created_idx').on(t.createdAt), index('notifications_unread_idx').on(t.readAt)],
);

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  deviceLabel: text('device_label'),
  createdAt: ts('created_at').defaultNow().notNull(),
  lastUsedAt: ts('last_used_at'),
});

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
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt), index('audit_log_action_idx').on(t.action)],
);

/**
 * Availability per day and per service, fed by the runner heartbeat (one tick per minute).
 * expected minutes for "today" are computed at read time.
 */
export const uptimeDaily = pgTable(
  'uptime_daily',
  {
    day: date('day').notNull(),
    /** 'runner' | 'web' | 'claude' */
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
