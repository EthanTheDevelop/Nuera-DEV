import 'server-only';
import { isAppError } from '@/server/errors';
import type { LinkFormState } from './link-forms';

/** Field errors of a Zod parse, by first path segment (« nom requis, … »). */
export function fieldErrorsOf(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? 'form');
    errors[key] = errors[key] ? `${errors[key]}, ${issue.message}` : issue.message;
  }
  return errors;
}

/** An error of a link action as form state (French AppError message, never a stack trace). */
export function linkFailure(scope: string, error: unknown, values?: Record<string, string>): LinkFormState {
  if (isAppError(error)) return { status: 'error', message: error.message, detail: error.detail, values };
  console.error(`[${scope}]`, error);
  return { status: 'error', message: 'Erreur inattendue du serveur. Réessayez.', values };
}

export const formText = (formData: FormData, name: string): string => String(formData.get(name) ?? '');
