import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, toAppError, toErrorBody, toErrorResponse } from './errors';

describe('AppError', () => {
  it('maps codes to HTTP statuses and default French messages', () => {
    expect(new AppError('NOT_FOUND')).toMatchObject({ code: 'NOT_FOUND', status: 404, message: 'Élément introuvable.' });
    expect(new AppError('RUNNER_UNAVAILABLE').status).toBe(503);
    expect(new AppError('VALIDATION').status).toBe(422);
  });

  it('accepts (code, message, options) and (code, options)', () => {
    const a = new AppError('CONFLICT', 'Ce dossier existe déjà.', { untouched: 'Aucun fichier modifié.' });
    expect(a).toMatchObject({ message: 'Ce dossier existe déjà.', untouched: 'Aucun fichier modifié.', status: 409 });
    const b = new AppError('UPSTREAM', { message: 'git push a échoué.', raw: 'fatal: …', status: 500 });
    expect(b).toMatchObject({ message: 'git push a échoué.', raw: 'fatal: …', status: 500 });
  });
});

describe('toErrorBody', () => {
  it('serialises an AppError with its optional fields only', () => {
    expect(toErrorBody(new AppError('FORBIDDEN', 'Non.', { detail: 'Origine refusée.' }))).toEqual({
      error: { code: 'FORBIDDEN', message: 'Non.', detail: 'Origine refusée.' },
    });
  });

  it('turns Zod errors into VALIDATION with a readable detail', () => {
    const parsed = z.object({ name: z.string().min(2, 'trop court') }).safeParse({ name: 'a' });
    expect(parsed.success).toBe(false);
    const body = toErrorBody(parsed.error);
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.detail).toBe('name : trop court');
  });

  it('never leaks unexpected error messages or stacks', () => {
    const body = toErrorBody(new Error('password=hunter2 at /srv/secret.ts:12'));
    expect(body).toEqual({ error: { code: 'INTERNAL', message: 'Erreur inattendue du serveur.' } });
    expect(toAppError('boom').code).toBe('INTERNAL');
  });

  it('builds a JSON response with Retry-After for RATE_LIMITED', async () => {
    const response = toErrorResponse(new AppError('RATE_LIMITED', { retryAfterSeconds: 42 }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });
});

describe('AppError across module copies', () => {
  it('keeps instanceof and the HTTP status when another copy of the module threw the error', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const other = await import('./runner/errors');
    const foreign = new other.RunnerError('CONFLICT', 'Session occupée.', { reason: 'SESSION_BUSY_PERMISSION' });
    expect(foreign).toBeInstanceOf(AppError);
    expect(toAppError(foreign)).toBe(foreign);
    expect(toErrorResponse(foreign).status).toBe(409);
    expect(toErrorBody(foreign).error).toMatchObject({ code: 'CONFLICT', reason: 'SESSION_BUSY_PERMISSION' });
    const { RunnerError } = await import('./runner/errors');
    expect(foreign).toBeInstanceOf(RunnerError);
    const { ProjectError } = await import('./projects/errors');
    expect(foreign instanceof ProjectError).toBe(false);
    expect({ code: 'CONFLICT' } instanceof AppError).toBe(false);
  });
});
