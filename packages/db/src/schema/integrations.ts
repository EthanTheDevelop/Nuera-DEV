import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';
import type {
  IntegrationKind,
  IntegrationStatus,
  McpAuthKind,
  McpServerConfig,
  McpStatus,
  McpTransport,
} from './types';

const ts = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Remote services used by Nuera Dev itself (GitHub App, Coolify API, Figma).
 * `config` holds NON-secret data only (ids, slugs, account logins, base URLs, permissions).
 * `secretsEncrypted` holds an AES-256-GCM encrypted JSON blob (private key, client secret, tokens…).
 */
export const integrations = pgTable('integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').$type<IntegrationKind>().notNull().unique(),
  status: text('status').$type<IntegrationStatus>().notNull().default('pending'),
  label: text('label'),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  secretsEncrypted: text('secrets_encrypted'),
  lastCheckedAt: ts('last_checked_at'),
  lastSuccessAt: ts('last_success_at'),
  lastError: text('last_error'),
  expiresAt: ts('expires_at'),
  createdAt: ts('created_at').defaultNow().notNull(),
  updatedAt: ts('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

/**
 * MCP servers made available to Claude Code sessions, activated project by project.
 * Synced to the CLI user scope with `claude mcp add-json --scope user` (diagnostics, OAuth login);
 * each session only loads the servers enabled for its project (`--mcp-config … --strict-mcp-config`).
 */
export const mcpServers = pgTable('mcp_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Identifier used in Claude Code config ("figma", "coolify"). [a-z0-9-] */
  name: text('name').notNull().unique(),
  label: text('label').notNull(),
  description: text('description'),
  /** Icon key from the design system icon set ("figma", "github", "coolify", "playwright"…). */
  icon: text('icon'),
  transport: text('transport').$type<McpTransport>().notNull(),
  url: text('url'),
  command: text('command'),
  args: jsonb('args').$type<string[]>().notNull().default([]),
  authKind: text('auth_kind').$type<McpAuthKind>().notNull().default('none'),
  /** Encrypted JSON: { headers?: Record<string,string>, env?: Record<string,string> } */
  secretsEncrypted: text('secrets_encrypted'),
  /** Names of headers/env keys (no values) so the UI can show what is configured. */
  secretKeys: jsonb('secret_keys').$type<string[]>().notNull().default([]),
  /** Non-secret settings: preset id, static headers, tools Claude must not call. */
  config: jsonb('config').$type<McpServerConfig>().notNull().default({}),
  /** Free text shown in the drawer: perimeter ("développement uniquement"), granted permissions. */
  scopeNote: text('scope_note'),
  permissionsNote: text('permissions_note'),
  isEnabled: boolean('is_enabled').notNull().default(true),
  status: text('status').$type<McpStatus>().notNull().default('unknown'),
  lastCheckedAt: ts('last_checked_at'),
  lastLatencyMs: integer('last_latency_ms'),
  lastError: text('last_error'),
  lastDiagnostic: jsonb('last_diagnostic').$type<Record<string, unknown>>(),
  /** Token / authorisation expiry when known (e.g. Coolify token). */
  expiresAt: ts('expires_at'),
  syncedToCliAt: ts('synced_to_cli_at'),
  createdAt: ts('created_at').defaultNow().notNull(),
  updatedAt: ts('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const projectMcpServers = pgTable(
  'project_mcp_servers',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    mcpServerId: uuid('mcp_server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.mcpServerId] })],
);
