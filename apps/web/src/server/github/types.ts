import 'server-only';
import { z } from 'zod';
import type { CheckHistoryEntry, IntegrationCheck } from '@/server/integrations/model';

/** Permission levels of a GitHub App (`read` < `write` < `admin`). */
export type GithubPermissionLevel = 'read' | 'write' | 'admin';
export type GithubPermissions = Record<string, string>;
/** Down-scoped token request: permission → level (research §2.5). */
export type GithubTokenPermissions = Partial<Record<string, 'read' | 'write'>>;

export const githubAccountSchema = z.object({
  login: z.string().min(1),
  id: z.number().int(),
  type: z.string().default('User'),
});

/** One installation of the app, as recorded in `integrations.config` (no secret). */
export const githubInstallationRecordSchema = z.object({
  id: z.number().int(),
  accountId: z.number().int(),
  accountLogin: z.string(),
  accountType: z.string(),
  repositorySelection: z.string().default('selected'),
  permissions: z.record(z.string(), z.string()).default({}),
  suspendedAt: z.string().nullable().default(null),
  suspendedBy: z.string().nullable().default(null),
  htmlUrl: z.string().nullable().default(null),
  repoCount: z.number().int().nullable().default(null),
  lastSyncAt: z.string().nullable().default(null),
});
export type GithubInstallationRecord = z.infer<typeof githubInstallationRecordSchema>;

/** Non-secret part of the GitHub integration row (`integrations.config`, kind = github). */
export const githubConfigSchema = z.object({
  mode: z.literal('app'),
  appId: z.number().int(),
  slug: z.string().min(1),
  clientId: z.string().min(1),
  name: z.string(),
  htmlUrl: z.string(),
  owner: githubAccountSchema.nullable().default(null),
  public: z.boolean().default(true),
  permissionsRequested: z.record(z.string(), z.string()).default({}),
  createdAt: z.string(),
  /** Accounts whose installations Nuera Dev uses (others are ignored, research §2.2). */
  allowedAccountIds: z.array(z.number().int()).default([]),
  installations: z.array(githubInstallationRecordSchema).default([]),
  /** Installations seen on GitHub but not allow-listed (count only, shown in the diagnostic). */
  ignoredInstallations: z.number().int().default(0),
  repoCount: z.number().int().nullable().default(null),
  consecutiveFailures: z.number().int().default(0),
  failingSince: z.string().nullable().default(null),
  lastCheck: z.custom<IntegrationCheck>().nullable().default(null),
  history: z.array(z.custom<CheckHistoryEntry>()).default([]),
});
export type GithubConfig = z.infer<typeof githubConfigSchema>;

/** Secret part, AES-256-GCM encrypted in `integrations.secrets_encrypted`. */
export const githubSecretsSchema = z.object({
  privateKeyPem: z.string().min(1),
  clientSecret: z.string().min(1),
  webhookSecret: z.string().nullable().default(null),
});
export type GithubSecrets = z.infer<typeof githubSecretsSchema>;

/** Response of `POST /app-manifests/{code}/conversions` (fields used). */
export const manifestConversionSchema = z.object({
  id: z.number().int(),
  slug: z.string().min(1),
  node_id: z.string().optional(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().nullable().optional(),
  pem: z.string().min(1),
  name: z.string(),
  html_url: z.string(),
  owner: z
    .object({ login: z.string(), id: z.number().int(), type: z.string().optional() })
    .nullable()
    .optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  events: z.array(z.string()).optional(),
});
export type ManifestConversion = z.infer<typeof manifestConversionSchema>;

/** Installation object from `GET /app/installations` (fields used). */
export const installationApiSchema = z.object({
  id: z.number().int(),
  account: z.object({ login: z.string(), id: z.number().int(), type: z.string().optional() }).nullable(),
  repository_selection: z.string().optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  suspended_at: z.string().nullable().optional(),
  suspended_by: z.object({ login: z.string() }).nullable().optional(),
  html_url: z.string().optional(),
  app_id: z.number().int().optional(),
});
export type InstallationApi = z.infer<typeof installationApiSchema>;

/** Repository object (fields used by A1 and project creation). */
export const repositoryApiSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  full_name: z.string(),
  owner: z.object({ login: z.string(), type: z.string().optional() }),
  private: z.boolean(),
  description: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  pushed_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  default_branch: z.string().optional(),
  archived: z.boolean().optional(),
  html_url: z.string(),
  clone_url: z.string().optional(),
});
export type RepositoryApi = z.infer<typeof repositoryApiSchema>;

export interface AccessibleRepo {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  ownerType: string;
  private: boolean;
  description: string | null;
  language: string | null;
  pushedAt: string | null;
  updatedAt: string | null;
  defaultBranch: string;
  cloneUrl: string;
  htmlUrl: string;
  archived: boolean;
  installationId: number | null;
  /** Project of Nuera Dev already tracking this repository (« Déjà cloné »), if any. */
  clonedProject: { id: string; name: string; slug: string } | null;
}

export interface AccessibleReposAccount {
  login: string;
  type: string;
  installationId: number | null;
  /** Installation settings on github.com (« gérer l'accès sur GitHub »). */
  manageUrl: string | null;
  count: number;
  repos: AccessibleRepo[];
}

export interface AccessibleReposResult {
  total: number;
  accounts: AccessibleReposAccount[];
  /** All repositories, most recently pushed first. */
  repos: AccessibleRepo[];
  manageAccessUrl: string | null;
  fetchedAt: string;
}

export interface GithubRepoInfo {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  description: string | null;
  language: string | null;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  pushedAt: string | null;
  archived: boolean;
}

export interface GithubBranch {
  name: string;
  sha: string;
  protected: boolean;
}

export interface CreatePullRequestInput {
  fullName: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
  maintainerCanModify?: boolean;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  createdAt: string | null;
}

export type ChecksState = 'success' | 'failure' | 'pending' | 'none' | 'unavailable';
export type ReviewsState = 'approved' | 'changes_requested' | 'pending' | 'none' | 'unavailable';

export interface PullRequestDetail extends PullRequestInfo {
  merged: boolean;
  mergedAt: string | null;
  mergeable: boolean | null;
  mergeableState: string | null;
  checks: {
    state: ChecksState;
    total: number;
    runs: Array<{ name: string; status: string; conclusion: string | null; url: string | null }>;
    statuses: Array<{ context: string; state: string; description: string | null; url: string | null }>;
  };
  reviews: {
    state: ReviewsState;
    approvals: number;
    changesRequested: number;
    requestedReviewers: string[];
  };
}

export type GithubMode = 'app' | 'fallback_token' | 'none';

export interface GithubPermissionsSummary {
  /** Raw permissions granted by the installations (lowest level across installations). */
  granted: GithubPermissions;
  /** Required permissions not (or not fully) granted. */
  missing: string[];
  /** « Contenu · pull requests » */
  title: string;
  /** « lecture et écriture ; issues, checks et statuts en lecture » */
  detail: string;
}

export interface GithubAccountStatus {
  login: string;
  type: string;
  installationId: number;
  repositorySelection: string;
  repoCount: number | null;
  suspended: boolean;
  suspendedBy: string | null;
  manageUrl: string | null;
}

export interface GithubStatus {
  mode: GithubMode;
  /** DB status of the integration row (`pending` = app registered, not installed yet). */
  status: 'not_configured' | 'pending' | 'connected' | 'expiring' | 'expired' | 'error';
  app: {
    id: number;
    slug: string;
    name: string;
    htmlUrl: string;
    public: boolean;
    ownerLogin: string | null;
    createdAt: string;
  } | null;
  accounts: GithubAccountStatus[];
  ignoredInstallations: number;
  repoCount: number | null;
  permissions: GithubPermissionsSummary;
  /** « Gérer l'accès » (app installations page on github.com). */
  manageAccessUrl: string | null;
  /** Start of the installation on another account (route that mints a fresh state). */
  installUrl: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  failingSince: string | null;
  lastError: string | null;
  reason: string | null;
  action: { label: string; kind: 'external' | 'terminal' | 'form' | 'internal'; url?: string } | null;
  /** Known credential expiry (PAT fallback only; installation tokens are re-minted hourly). */
  expiresAt: string | null;
  lastCheck: IntegrationCheck | null;
  history: CheckHistoryEntry[];
}
