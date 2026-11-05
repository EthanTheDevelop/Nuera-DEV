import { RUNNER_ERROR_STATUS, type RunnerErrorBody, type RunnerErrorCode, type RunnerErrorReason } from '@nuera/shared/runner';
import { isPathGuardError } from '@nuera/shared/paths';
import { ZodError } from 'zod';
import { redactSecrets } from './safety/redact';

export interface RunnerErrorOptions {
  detail?: string;
  raw?: string;
  untouched?: string;
  reason?: RunnerErrorReason | (string & {});
  data?: Record<string, unknown>;
  status?: number;
  cause?: unknown;
}

/** Error thrown by every runner module; serialised as `{ error: { code, message, … } }`. */
export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  readonly status: number;
  readonly detail?: string;
  readonly raw?: string;
  readonly untouched?: string;
  readonly reason?: string;
  readonly data?: Record<string, unknown>;

  constructor(code: RunnerErrorCode, message: string, options: RunnerErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RunnerError';
    this.code = code;
    this.status = options.status ?? RUNNER_ERROR_STATUS[code];
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.raw !== undefined) this.raw = options.raw;
    if (options.untouched !== undefined) this.untouched = options.untouched;
    if (options.reason !== undefined) this.reason = options.reason;
    if (options.data !== undefined) this.data = options.data;
  }
}

export const notFound = (message: string, options?: RunnerErrorOptions) => new RunnerError('NOT_FOUND', message, options);
export const conflict = (message: string, options?: RunnerErrorOptions) => new RunnerError('CONFLICT', message, options);
export const invalid = (message: string, options?: RunnerErrorOptions) => new RunnerError('VALIDATION', message, options);

function zodSummary(error: ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const p = issue.path.map(String).join('.');
      return p ? `${p} : ${issue.message}` : issue.message;
    })
    .join(' ; ');
}

/** Converts anything thrown into a RunnerError (unknown errors → INTERNAL without leaking details). */
export function toRunnerError(error: unknown): RunnerError {
  if (error instanceof RunnerError) return error;
  if (error instanceof ZodError) return new RunnerError('VALIDATION', 'Données invalides.', { detail: zodSummary(error) });
  if (isPathGuardError(error)) {
    return new RunnerError('VALIDATION', error.message, { reason: 'PATH_REJECTED', detail: error.code });
  }
  const fastifyCode = (error as { code?: unknown } | null)?.code;
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    if (fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE') return new RunnerError('VALIDATION', 'Requête trop volumineuse.');
    if (statusCode === 404) return new RunnerError('NOT_FOUND', 'Route inconnue.');
    return new RunnerError('VALIDATION', 'Requête invalide.', {
      detail: typeof (error as Error).message === 'string' ? (error as Error).message.slice(0, 300) : undefined,
    });
  }
  return new RunnerError('INTERNAL', 'Erreur inattendue du runner.', { cause: error });
}

export function toErrorBody(error: RunnerError): RunnerErrorBody {
  const body: RunnerErrorBody = { error: { code: error.code, message: error.message } };
  if (error.detail) body.error.detail = redactSecrets(error.detail);
  if (error.raw) body.error.raw = redactSecrets(error.raw);
  if (error.untouched) body.error.untouched = error.untouched;
  if (error.reason) body.error.reason = error.reason;
  if (error.data) body.error.data = error.data;
  return body;
}
