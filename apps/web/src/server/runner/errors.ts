import 'server-only';
import { AppError, type AppErrorCode } from '@/server/errors';

export interface RunnerErrorOptions {
  status?: number;
  detail?: string;
  raw?: string;
  untouched?: string;
  reason?: string;
  data?: Record<string, unknown>;
  /** Server (environment) whose runner produced or failed the call. */
  environmentId?: string;
  cause?: unknown;
}

/**
 * AppError enriched with the runner's machine-readable sub-code (`reason`), its data and the server
 * (environment) it comes from.
 */
export class RunnerError extends AppError {
  readonly environmentId?: string;
  constructor(code: AppErrorCode, message: string, options: RunnerErrorOptions = {}) {
    const { environmentId, ...rest } = options;
    super(code, message, rest);
    this.name = 'RunnerError';
    if (environmentId !== undefined) this.environmentId = environmentId;
  }
}

/** True when the error means « the runner cannot be reached » (Figma T5). */
export function isRunnerUnavailable(error: unknown): boolean {
  return error instanceof AppError && error.code === 'RUNNER_UNAVAILABLE';
}

/** « VPS-3 ne répond pas : le runner est injoignable. » — the server name comes from its row. */
export function runnerUnavailableMessage(environmentName: string): string {
  return `${environmentName} ne répond pas : le runner est injoignable.`;
}
