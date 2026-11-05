import 'server-only';
import { Octokit } from '@octokit/rest';
import { AppError } from '@/server/errors';
import { providerMessageOf, sanitizeText } from '@/server/integrations/redact';
import { GITHUB_API_VERSION, GITHUB_TIMEOUT_MS, githubApiUrl } from './config';

export type { Octokit };

const quietLog = {
  debug: () => {},
  info: () => {},
  warn: (message: string) => console.warn('[github]', sanitizeText(message, 500)),
  error: () => {},
};

/**
 * Octokit bound to GITHUB_API_URL, sending `X-GitHub-Api-Version: 2026-03-10` and a per-request
 * timeout. `auth` is an installation token, a JWT (app) or the fallback PAT; omit it for the
 * unauthenticated manifest conversion.
 */
export function createOctokit(auth?: string, options: { timeoutMs?: number } = {}): Octokit {
  const octokit = new Octokit({
    baseUrl: githubApiUrl(),
    userAgent: 'nuera-dev',
    log: quietLog,
    ...(auth ? { auth } : {}),
  });
  const timeoutMs = options.timeoutMs ?? GITHUB_TIMEOUT_MS;
  octokit.hook.before('request', (endpoint) => {
    endpoint.headers['x-github-api-version'] = GITHUB_API_VERSION;
    if (!endpoint.request.signal) endpoint.request.signal = AbortSignal.timeout(timeoutMs);
  });
  return octokit;
}

/** HTTP status of an Octokit RequestError (duck-typed: @octokit/request-error is not a direct dependency). */
export function githubErrorStatus(error: unknown): number | null {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

export function githubErrorHeaders(error: unknown): Record<string, string> {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { headers?: Record<string, unknown> } }).response;
    if (response?.headers) {
      return Object.fromEntries(
        Object.entries(response.headers)
          .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
          .map(([key, value]) => [key.toLowerCase(), String(value)]),
      );
    }
  }
  return {};
}

/** Provider message of an Octokit error (sanitised), e.g. « Bad credentials ». */
export function githubErrorMessage(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: unknown } }).response?.data;
    const message = providerMessageOf(data);
    if (message) return message;
    if (data && typeof data === 'object' && 'errors' in data) {
      const errors = (data as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        const parts = errors
          .map((item) => (item && typeof item === 'object' && 'message' in item ? String((item as { message: unknown }).message) : null))
          .filter(Boolean);
        if (parts.length) return sanitizeText(parts.join(' ; '), 300);
      }
    }
  }
  if (error instanceof Error) return sanitizeText(error.message, 300);
  return undefined;
}

/** True for network errors, timeouts and 5xx answers (transient: retried, hysteresis applies). */
export function isTransientGithubError(error: unknown): boolean {
  const status = githubErrorStatus(error);
  if (status === null) return true;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return true;
  return status >= 500 || status === 429;
}

/** Full error message of a GitHub error response, including validation details. */
function detailedMessage(error: unknown): string | undefined {
  const base = githubErrorMessage(error);
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: unknown } }).response?.data;
    if (data && typeof data === 'object' && 'errors' in data) {
      const errors = (data as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        const extra = errors
          .map((item) => (item && typeof item === 'object' && 'message' in item ? String((item as { message: unknown }).message) : null))
          .filter((value): value is string => Boolean(value));
        if (extra.length) return sanitizeText([base, ...extra].filter(Boolean).join(' — '), 500);
      }
    }
  }
  return base;
}

/**
 * Maps a GitHub error to an AppError (French message, raw provider message « à un clic »).
 * `context` names what failed (« la création de la pull request »).
 */
export function toGithubAppError(error: unknown, context: string): AppError {
  if (error instanceof AppError) return error;
  const status = githubErrorStatus(error);
  const raw = detailedMessage(error);
  const timedOut = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
  if (timedOut || status === null || (status === 500 && !raw)) {
    return new AppError('UPSTREAM', `GitHub ne répond pas : ${context} n'a pas abouti.`, {
      ...(raw ? { raw } : {}),
      untouched: "Rien n'a été modifié sur GitHub.",
    });
  }
  if (status === 401) {
    return new AppError('UPSTREAM', "GitHub refuse l'authentification de Nuera Dev.", {
      detail: 'Vérifiez la connexion dans Intégrations.',
      ...(raw ? { raw } : {}),
    });
  }
  if (status === 403 || status === 404) {
    return new AppError('FORBIDDEN', `Accès refusé par GitHub pour ${context}.`, {
      detail: "Le dépôt n'est peut-être pas sélectionné dans l'installation de l'application GitHub, ou un droit manque.",
      ...(raw ? { raw } : {}),
    });
  }
  if (status === 409) {
    return new AppError('CONFLICT', `GitHub signale un conflit pendant ${context}.`, raw ? { raw } : {});
  }
  if (status === 422) {
    return new AppError('VALIDATION', `GitHub a refusé ${context}.`, raw ? { detail: raw, raw } : {});
  }
  if (status === 429) {
    return new AppError('RATE_LIMITED', 'Limite de requêtes GitHub atteinte. Réessayez dans quelques minutes.', raw ? { raw } : {});
  }
  return new AppError('UPSTREAM', `GitHub a renvoyé une erreur pendant ${context}.`, {
    ...(raw ? { raw } : {}),
    untouched: "Rien n'a été modifié sur GitHub.",
  });
}
