import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { spaces } from './tenancy';
import type { GithubSourceKind, IntegrationStatus } from './types';

const ts = (name: string) => timestamp(name, { withTimezone: true });

/**
 * GitHub sources of a space (several per space): one row per GitHub App. Migration 0002 moved the
 * former `integrations` row of kind `github` here, with the same id.
 * `config` holds the non-secret payload of the app (ids, slug, owner, allowed accounts,
 * installations…); `secrets_encrypted` the AES-256-GCM encrypted private key and client secret.
 */
export const githubSources = pgTable(
  'github_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<GithubSourceKind>().notNull().default('app'),
    label: text('label'),
    /** GitHub App id (unique across the instance). */
    appId: bigint('app_id', { mode: 'number' }),
    ownerLogin: text('owner_login'),
    /** `User` | `Organization`, as returned by GitHub. */
    ownerType: text('owner_type'),
    status: text('status').$type<IntegrationStatus>().notNull().default('pending'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    secretsEncrypted: text('secrets_encrypted'),
    lastCheckedAt: ts('last_checked_at'),
    lastSuccessAt: ts('last_success_at'),
    lastError: text('last_error'),
    expiresAt: ts('expires_at'),
    createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    // Target of the composite foreign key projects (github_source_id, space_id).
    unique('github_sources_id_space_key').on(t.id, t.spaceId),
    uniqueIndex('github_sources_app_id_idx').on(t.appId).where(sql`${t.appId} is not null`),
    index('github_sources_space_idx').on(t.spaceId),
  ],
);
