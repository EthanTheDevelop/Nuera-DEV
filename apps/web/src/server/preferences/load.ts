import 'server-only';
import type { Load, LoadError } from '@/features/settings/lib/types';
import { toAppError } from '@/server/errors';
import { isRunnerUnavailable } from '@/server/runner/client';

/**
 * French error body of a section that failed (T4), never a stack trace. Two failures get a flag of
 * their own: the runner of the account's server does not answer (`unavailable`), or no server is
 * assigned to the account yet (`noEnvironment`, AppError reason NO_ENVIRONMENT of `requireEnvironment`).
 */
export function toLoadError(error: unknown): LoadError {
  const appError = toAppError(error);
  if (appError.code === 'INTERNAL') console.error('[paramètres]', error);
  return {
    message: appError.message,
    ...(appError.detail ? { detail: appError.detail } : {}),
    ...(appError.raw ? { raw: appError.raw } : {}),
    ...(isRunnerUnavailable(error) ? { unavailable: true } : {}),
    ...(appError.reason === 'NO_ENVIRONMENT' ? { noEnvironment: true } : {}),
  };
}

/** Runs one section loader: a failure stays inline, the rest of the page renders. */
export async function load<T>(fn: () => Promise<T>): Promise<Load<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: toLoadError(error) };
  }
}

export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
