import 'server-only';
import { environments } from '@nuera/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { AppError } from '@/server/errors';

/**
 * Environment of the GitHub integration.
 *   APP_URL          public URL of Nuera Dev (manifest URLs, redirects)
 *   GITHUB_API_URL   REST base (default https://api.github.com) — overridden by tests / e2e
 *   GITHUB_WEB_URL   github.com base for browser redirects (default https://github.com) — e2e only
 *   GITHUB_FALLBACK_TOKEN  documented fallback (fine-grained PAT), never offered in the UI, reserved to
 *                    the space of the default server and never served to an MCP server (MULTICOMPTE §7)
 */

/** GitHub sources of a space (MULTICOMPTE §7). */
export const MAX_GITHUB_SOURCES_PER_SPACE = 10;

/** REST API version sent on every call (research §2.4: `merge_commit_sha` is gone in this version). */
export const GITHUB_API_VERSION = '2026-03-10';

/** Default request timeout for GitHub REST calls. */
export const GITHUB_TIMEOUT_MS = 20_000;

/** Permissions requested by the manifest and required for a « Connecté » status. */
export const GITHUB_REQUIRED_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
  checks: 'read',
  statuses: 'read',
  issues: 'read',
} as const satisfies Record<string, 'read' | 'write'>;

const trimSlash = (value: string) => value.replace(/\/+$/, '');

export function githubApiUrl(): string {
  return trimSlash(process.env.GITHUB_API_URL?.trim() || 'https://api.github.com');
}

export function githubWebUrl(): string {
  return trimSlash(process.env.GITHUB_WEB_URL?.trim() || 'https://github.com');
}

/** Public origin of Nuera Dev (APP_URL), without trailing slash. */
export function appUrl(): string {
  const value = process.env.APP_URL?.trim();
  if (!value) {
    throw new AppError('INTERNAL', "APP_URL n'est pas configurée : impossible de construire les adresses de retour GitHub.");
  }
  try {
    const url = new URL(value);
    return trimSlash(url.origin + url.pathname);
  } catch {
    throw new AppError('INTERNAL', 'APP_URL est invalide.');
  }
}

/** Raw GITHUB_FALLBACK_TOKEN: only {@link fallbackTokenFor} hands it out (bound to one space). */
function rawFallbackToken(): string | null {
  const value = process.env.GITHUB_FALLBACK_TOKEN?.trim();
  return value ? value : null;
}

/** Space of the default server (the one GITHUB_FALLBACK_TOKEN belongs to), or null. */
export async function defaultServerSpaceId(): Promise<string | null> {
  const { db } = await import('@/server/db');
  const [row] = await db
    .select({ spaceId: environments.spaceId })
    .from(environments)
    .where(and(eq(environments.isDefault, true), isNotNull(environments.spaceId)))
    .limit(1);
  return row?.spaceId ?? null;
}

/**
 * GITHUB_FALLBACK_TOKEN for `spaceId`: only the space of the default server gets it (the token is
 * the instance owner's, it can neither be limited to one repository nor made read-only).
 */
export async function fallbackTokenFor(spaceId: string): Promise<string | null> {
  const token = rawFallbackToken();
  if (!token) return null;
  return (await defaultServerSpaceId()) === spaceId ? token : null;
}

/** `owner/repo` → parts, validated (GitHub logins and repository names). */
export function parseFullName(fullName: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(fullName.trim());
  if (!match || match[2] === '.' || match[2] === '..') {
    throw new AppError('VALIDATION', 'Dépôt GitHub invalide.', { detail: 'Format attendu : propriétaire/dépôt.' });
  }
  return { owner: match[1]!, repo: match[2]! };
}
