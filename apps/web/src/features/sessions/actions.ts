'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { requireContext } from '@/server/tenancy/context';
import { toAppError } from '@/server/errors';
import { assertSameOriginHeaders } from '@/server/security/origin';
import { assertRateLimit } from '@/server/security/rate-limit';
import { getNewSessionOptions, getProjectBranchOptions, sendFirstInstruction } from '@/server/sessions';
import { INSTRUCTION_MAX, type NewSessionOptions, type ProjectBranchOptions } from './lib/contract';

/**
 * Server actions of the « Nouvelle session » dialog (reads its options; re-sends a first
 * instruction that failed). Each one re-checks the session and its space (requireContext) and the
 * Origin; an id of another space comes back as NOT_FOUND, like an unknown id.
 * Errors come back as data (`{ ok: false, error }`): Next hides thrown messages in production.
 */

export type ActionError = { message: string; detail?: string; untouched?: string; raw?: string; code: string };
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };

async function guard() {
  const ctx = await requireContext();
  assertSameOriginHeaders(await headers());
  return ctx;
}

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    const appError = toAppError(error);
    if (appError.code === 'INTERNAL') console.error('[sessions] action', error);
    return {
      ok: false,
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.detail ? { detail: appError.detail } : {}),
        ...(appError.untouched ? { untouched: appError.untouched } : {}),
        ...(appError.raw ? { raw: appError.raw } : {}),
      },
    };
  }
}

export async function loadNewSessionOptionsAction(): Promise<ActionResult<NewSessionOptions>> {
  return run(async () => {
    const ctx = await guard();
    return getNewSessionOptions(ctx);
  });
}

const projectIdSchema = z.uuid();

export async function loadProjectBranchesAction(projectId: string): Promise<ActionResult<ProjectBranchOptions>> {
  return run(async () => {
    const ctx = await guard();
    assertRateLimit('sessions:branches', ctx.user.id, { limit: 120, windowMs: 60_000 });
    return getProjectBranchOptions(ctx, projectIdSchema.parse(projectId));
  });
}

const instructionSchema = z.object({ sessionId: z.uuid(), text: z.string().min(1).max(INSTRUCTION_MAX) });

export async function retryFirstInstructionAction(sessionId: string, text: string): Promise<ActionResult<'delivered' | 'queued'>> {
  return run(async () => {
    const ctx = await guard();
    assertRateLimit('sessions:first-instruction', ctx.user.id, { limit: 20, windowMs: 10 * 60_000 });
    const input = instructionSchema.parse({ sessionId, text });
    return sendFirstInstruction(ctx, input.sessionId, input.text);
  });
}
