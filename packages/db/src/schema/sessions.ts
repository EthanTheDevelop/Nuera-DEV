import {
  bigserial,
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
import { user } from './auth';
import { projects, worktrees } from './projects';
import type {
  PermissionMode,
  PermissionRequestStatus,
  SessionBackend,
  SessionEventKind,
  SessionStatus,
} from './types';

const ts = (name: string) => timestamp(name, { withTimezone: true });

/**
 * A Claude Code session. `id` is ALSO the Claude conversation id passed to `claude --session-id`
 * and reused by `claude --resume`.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    worktreeId: uuid('worktree_id').references(() => worktrees.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    status: text('status').$type<SessionStatus>().notNull().default('new'),
    backend: text('backend').$type<SessionBackend>().notNull().default('tmux'),
    /** tmux session name ("nuera-nuera-os-crm-core"), null for the direct PTY backend. */
    tmuxName: text('tmux_name'),
    pid: integer('pid'),
    permissionMode: text('permission_mode').$type<PermissionMode>().notNull().default('manual'),
    model: text('model'),
    effort: text('effort'),
    remoteControl: boolean('remote_control').notNull().default(false),
    remoteControlUrl: text('remote_control_url'),
    transcriptPath: text('transcript_path'),
    /** sha256 of the per-session hook token (the clear token only lives in the runner). */
    hookTokenHash: text('hook_token_hash'),
    lastInstruction: text('last_instruction'),
    /** Short live description ("Écrit les tests de pipeline-totals.ts"). */
    currentActivity: text('current_activity'),
    planDone: integer('plan_done'),
    planTotal: integer('plan_total'),
    /** Latest status-line JSON published by the CLI (model, context %, rate limits) — never estimated. */
    cliStatus: jsonb('cli_status').$type<Record<string, unknown>>(),
    resumeCount: integer('resume_count').notNull().default(0),
    exitCode: integer('exit_code'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    lastActivityAt: ts('last_activity_at'),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    archivedAt: ts('archived_at'),
    createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index('sessions_project_idx').on(t.projectId),
    index('sessions_status_idx').on(t.status),
    index('sessions_created_at_idx').on(t.createdAt),
  ],
);

/**
 * Normalised conversation stream of a session (rendered by the "Conversation" view).
 * - `position`: creation order (display order).
 * - `version`: change order (monotonic per session; bumped on every insert/update) used for SSE catch-up.
 * - `key`: optional stable key for upserts (e.g. `tool:<toolUseId>`, `plan`, `permission:<id>`).
 */
export const sessionEvents = pgTable(
  'session_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    version: integer('version').notNull(),
    key: text('key'),
    kind: text('kind').$type<SessionEventKind>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('session_events_session_position_idx').on(t.sessionId, t.position),
    uniqueIndex('session_events_session_key_idx').on(t.sessionId, t.key),
    index('session_events_session_version_idx').on(t.sessionId, t.version),
  ],
);

export const permissionRequests = pgTable(
  'permission_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    toolInput: jsonb('tool_input').$type<Record<string, unknown>>().notNull(),
    /** "Claude demande à exécuter une commande" */
    title: text('title').notNull(),
    /** Command / path / target shown in the dark block ("npm run test -- crm"). */
    target: text('target'),
    /** Optional explanation (description field of the tool input). */
    detail: text('detail'),
    /** `permission_suggestions` from the hook — used by "Toujours pour …". */
    suggestions: jsonb('suggestions').$type<unknown[]>(),
    status: text('status').$type<PermissionRequestStatus>().notNull().default('pending'),
    decisionMessage: text('decision_message'),
    decidedAt: ts('decided_at'),
    decidedByUserId: text('decided_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    expiresAt: ts('expires_at'),
    createdAt: ts('created_at').defaultNow().notNull(),
  },
  (t) => [index('permission_requests_session_status_idx').on(t.sessionId, t.status)],
);
