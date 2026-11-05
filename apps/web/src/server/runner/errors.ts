import 'server-only';
import { AppError, type AppErrorCode } from '@/server/errors';

/** AppError enriched with the runner's machine-readable sub-code (`reason`) and data. */
export class RunnerError extends AppError {
  readonly reason?: string;
  readonly data?: Record<string, unknown>;
  constructor(
    code: AppErrorCode,
    message: string,
    options: {
      status?: number;
      detail?: string;
      raw?: string;
      untouched?: string;
      reason?: string;
      data?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    const { reason, data, ...rest } = options;
    super(code, message, rest);
    this.name = 'RunnerError';
    if (reason !== undefined) this.reason = reason;
    if (data !== undefined) this.data = data;
  }
}

/** True when the error means « the runner cannot be reached » (Figma T5). */
export function isRunnerUnavailable(error: unknown): boolean {
  return error instanceof AppError && error.code === 'RUNNER_UNAVAILABLE';
}
