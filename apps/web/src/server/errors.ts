import 'server-only';
import { ZodError } from 'zod';

/**
 * Application errors shared by every server module (route handlers, server actions, services).
 *
 *   throw new AppError('NOT_FOUND');
 *   throw new AppError('CONFLICT', 'Ce dossier existe déjà sur VPS-3.', { untouched: 'Aucun fichier modifié.' });
 *   throw new AppError('UPSTREAM', { message: 'git push a échoué.', raw: stderr });
 *
 * Messages are French and shown as-is in the UI. `raw` is the raw command output displayed "à un
 * clic" (règle T4), `untouched` says what was NOT modified, `detail` adds context, `reason` is a
 * machine-readable sub-code the UI may branch on (`NO_ENVIRONMENT`, `ENVIRONMENT_DISABLED`…).
 * Never put secrets in any of these fields: they are sent to the browser (`data` is not).
 */
export type AppErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'RUNNER_UNAVAILABLE'
  | 'UPSTREAM'
  | 'INTERNAL';

export const APP_ERROR_STATUS: Readonly<Record<AppErrorCode, number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  RUNNER_UNAVAILABLE: 503,
  UPSTREAM: 502,
  INTERNAL: 500,
};

export const APP_ERROR_MESSAGES: Readonly<Record<AppErrorCode, string>> = {
  UNAUTHORIZED: 'Connexion requise.',
  FORBIDDEN: 'Action non autorisée.',
  NOT_FOUND: 'Élément introuvable.',
  VALIDATION: 'Données invalides.',
  CONFLICT: "Conflit avec l'état actuel.",
  RATE_LIMITED: 'Trop de tentatives. Réessayez dans un instant.',
  RUNNER_UNAVAILABLE: 'VPS-3 ne répond pas.',
  UPSTREAM: 'Le service distant a renvoyé une erreur.',
  INTERNAL: 'Erreur inattendue du serveur.',
};

export interface AppErrorOptions {
  /** Overrides the default French message of the code. */
  message?: string;
  /** Overrides the HTTP status derived from the code. */
  status?: number;
  detail?: string;
  raw?: string;
  untouched?: string;
  /** Seconds before a retry makes sense (RATE_LIMITED); sent as `Retry-After`. */
  retryAfterSeconds?: number;
  /** Machine-readable sub-code (« NO_ENVIRONMENT »…), sent with the error body. */
  reason?: string;
  /** Structured data for server-side callers (never serialised by {@link toErrorBody}). */
  data?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Brand shared by every copy of this module. `next dev` can instantiate a server module once per
 * layer (route handler, RSC, server action): an AppError thrown by one copy then fails
 * `instanceof AppError` in another and turned into a 500 (runner CONFLICT → « Erreur inattendue »).
 * `Symbol.for` is global to the process, so the brand survives module duplication.
 */
const APP_ERROR_BRAND = Symbol.for('nuera.AppError');

export class AppError extends Error {
  /**
   * `instanceof AppError` (and of any subclass) also accepts an error branded by another copy of
   * this module; a subclass additionally requires the same `name` (« RunnerError »).
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    if (typeof value !== 'object' || value === null) return false;
    if ((value as Record<symbol, unknown>)[APP_ERROR_BRAND] !== true) return false;
    return this === AppError || (value as Error).name === this.name;
  }

  readonly code: AppErrorCode;
  readonly status: number;
  readonly detail?: string;
  readonly raw?: string;
  readonly untouched?: string;
  readonly retryAfterSeconds?: number;
  readonly reason?: string;
  readonly data?: Record<string, unknown>;

  constructor(code: AppErrorCode, message?: string, options?: Omit<AppErrorOptions, 'message'>);
  constructor(code: AppErrorCode, options?: AppErrorOptions);
  constructor(
    code: AppErrorCode,
    messageOrOptions?: string | AppErrorOptions,
    maybeOptions: Omit<AppErrorOptions, 'message'> = {},
  ) {
    const options: AppErrorOptions =
      typeof messageOrOptions === 'string'
        ? { ...maybeOptions, message: messageOrOptions }
        : (messageOrOptions ?? {});
    super(options.message ?? APP_ERROR_MESSAGES[code], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    Object.defineProperty(this, APP_ERROR_BRAND, { value: true });
    this.code = code;
    this.status = options.status ?? APP_ERROR_STATUS[code];
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.raw !== undefined) this.raw = options.raw;
    if (options.untouched !== undefined) this.untouched = options.untouched;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.data !== undefined) this.data = options.data;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export interface ErrorBody {
  error: {
    code: AppErrorCode;
    message: string;
    detail?: string;
    raw?: string;
    untouched?: string;
    reason?: string;
  };
}

/** Readable French summary of Zod issues (« nom : trop court ; email : adresse invalide »). */
export function formatZodIssues(error: ZodError, max = 4): string {
  return error.issues
    .slice(0, max)
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path} : ${issue.message}` : issue.message;
    })
    .join(' ; ');
}

/** Converts anything thrown into an AppError. Unknown errors become INTERNAL (no message leak). */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new AppError('VALIDATION', { detail: formatZodIssues(error), cause: error });
  }
  return new AppError('INTERNAL', { cause: error });
}

/** JSON body sent to the browser for an error. Never contains a stack trace. */
export function toErrorBody(error: unknown): ErrorBody {
  const appError = toAppError(error);
  const body: ErrorBody = { error: { code: appError.code, message: appError.message } };
  if (appError.detail) body.error.detail = appError.detail;
  if (appError.raw) body.error.raw = appError.raw;
  if (appError.untouched) body.error.untouched = appError.untouched;
  if (appError.reason) body.error.reason = appError.reason;
  return body;
}

/** HTTP response for an error (status from the code, `Retry-After` for RATE_LIMITED). */
export function toErrorResponse(error: unknown): Response {
  const appError = toAppError(error);
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  if (appError.retryAfterSeconds !== undefined) {
    headers.set('retry-after', String(Math.max(1, Math.ceil(appError.retryAfterSeconds))));
  }
  return new Response(JSON.stringify(toErrorBody(appError)), { status: appError.status, headers });
}
