import 'server-only';
import { AppError } from '@/server/errors';
import { appUrl } from './config';

/**
 * Browser redirects of the GitHub flows. Outcomes are passed to the Intégrations page as
 * `?github=<code>` (documented in docs/INTEGRATIONS.md) — never a raw provider message.
 */

export type GithubFlowOutcome =
  | 'app_created'
  | 'installed'
  | 'updated'
  | 'requested'
  | 'state_invalid'
  | 'state_expired'
  | 'already_connected'
  | 'conversion_failed'
  | 'installation_unknown'
  | 'installation_failed'
  | 'not_connected';

export function redirectResponse(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

/** Absolute URL of the Intégrations page with the outcome code. */
export function integrationsUrl(outcome: GithubFlowOutcome, extra: Record<string, string> = {}): string {
  const url = new URL('/integrations', `${appUrl()}/`);
  url.searchParams.set('github', outcome);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url.toString();
}

/** Maps an error of the flow to an outcome code. */
export function outcomeOfError(error: unknown, fallback: GithubFlowOutcome): GithubFlowOutcome {
  if (error instanceof AppError) {
    if (error.code === 'FORBIDDEN') return error.message.includes('expiré') ? 'state_expired' : 'state_invalid';
    if (error.code === 'CONFLICT') return error.message.includes('déjà') ? 'already_connected' : fallback;
  }
  return fallback;
}
