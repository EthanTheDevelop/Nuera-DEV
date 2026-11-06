import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { spaces } from './tenancy';
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
 * Remote services used by Nuera Dev itself, one row per space and kind (Coolify API, Figma).
 * GitHub sources live in `github_sources` (several per space).
 * `config` holds NON-secret data only (ids, slugs, account logins, base URLs, permissions).
 * `secretsEncrypted` holds an AES-256-GCM encrypted JSON blob (private key, client secret, tokens…).
 */
export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<IntegrationKind>().notNull(),
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
  },
  // Target of INSERT … ON CONFLICT (space_id, kind).
  (t) => [uniqueIndex('integrations_space_kind_idx').on(t.spaceId, t.kind)],
);

/**
 * MCP servers made available to Claude Code sessions, activated project by project. One registry
 * per space (names unique in a space). Synced to the CLI user scope of the space's server with
 * `claude mcp add-json --scope user` (diagnostics, OAuth login): `synced_to_cli_at` and the
 * authentication state belong to that server, which holds while a space has a single server.
 * Each session only loads the servers enabled for its project (`--mcp-config … --strict-mcp-config`).
 */
export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'restrict' }),
    /** Identifier used in Claude Code config ("figma", "coolify"), unique in a space. [a-z0-9-] */
    name: text('name').notNull(),
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
  },
  // Target of INSERT … ON CONFLICT (space_id, name) (preset servers created with each space).
  (t) => [uniqueIndex('mcp_servers_space_name_idx').on(t.spaceId, t.name)],
);

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
