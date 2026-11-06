import 'server-only';
import { permissionRequests, projects, sessions } from '@nuera/db/schema';
import type { PermissionRequestDto } from '@nuera/shared/runner';
import { and, eq } from 'drizzle-orm';
import type { PermissionDecisionInput, PermissionOptionId } from '@/features/workspace/lib/contract';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { assertCanDriveSession } from '@/server/sessions';
import type { RequestContext } from '@/server/tenancy/context';
import { auditIn, NOT_FOUND_MESSAGES, scopeOfPermission } from '@/server/tenancy/scope';

/**
 * « Autoriser » / « Toujours pour … » / « Refuser » of `Dev · Demande d'autorisation` (D05, M05,
 * S1, S5). The decision is handed to the CLI's own PermissionRequest hook by the runner (official
 * format, the CLI's rule suggestion used verbatim for « Toujours »): the permission mode is never
 * bypassed. The request must belong to a session of the space (an id of another space answers
 * like an unknown id, before any runner call) and the decision goes to the runner of the session's
 * server. Audited `permission.decision` in the space, with the account that decided — the
 * journal (D08) shows « « toujours autoriser » npm run test · Nuera OS ».
 */

export const PERMISSION_AUDIT_ACTION = 'permission.decision';

export function decisionFromOption(optionId: PermissionOptionId): { behavior: 'allow' | 'deny'; always: boolean } {
  switch (optionId) {
    case 'allow':
      return { behavior: 'allow', always: false };
    case 'allow_always':
      return { behavior: 'allow', always: true };
    case 'deny':
      return { behavior: 'deny', always: false };
  }
}

const DECISION_WORDS: Record<PermissionOptionId, string> = {
  allow: '« autoriser une fois »',
  allow_always: '« toujours autoriser »',
  deny: '« refuser »',
};

/** « « toujours autoriser » npm run test · Nuera OS » (D08 journal line, pure). */
export function permissionAuditSummary(input: {
  optionId: PermissionOptionId;
  target: string | null;
  toolName: string;
  alwaysPrefix?: string | null;
  projectName: string;
}): string {
  const subject = (input.optionId === 'allow_always' && input.alwaysPrefix) || input.target || input.toolName;
  return `${DECISION_WORDS[input.optionId]} ${subject} · ${input.projectName}`;
}

/** Prefix of « Toujours pour npm run test » (alwaysLabel of the runner DTO). */
export function alwaysPrefix(alwaysLabel: string | null | undefined): string | null {
  if (!alwaysLabel) return null;
  return alwaysLabel.replace(/^Toujours pour\s+/i, '').trim() || null;
}

export async function decidePermission(
  ctx: Pick<RequestContext, 'user' | 'space' | 'environment'>,
  permissionId: string,
  input: PermissionDecisionInput,
): Promise<PermissionRequestDto> {
  const scope = await scopeOfPermission(ctx, permissionId);
  const [row] = await db
    .select({
      id: permissionRequests.id,
      sessionId: permissionRequests.sessionId,
      toolName: permissionRequests.toolName,
      target: permissionRequests.target,
      status: permissionRequests.status,
      suggestions: permissionRequests.suggestions,
      projectId: sessions.projectId,
      projectName: projects.name,
      projectArchivedAt: projects.archivedAt,
      sessionTitle: sessions.title,
    })
    .from(permissionRequests)
    .innerJoin(sessions, eq(sessions.id, permissionRequests.sessionId))
    .innerJoin(projects, and(eq(projects.id, sessions.projectId), eq(projects.environmentId, sessions.environmentId)))
    .where(and(eq(permissionRequests.id, scope.permissionId), eq(projects.spaceId, ctx.space.id)))
    .limit(1);
  if (!row || row.projectArchivedAt) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGES.permission);
  assertCanDriveSession(ctx, scope);
  if (input.optionId === 'allow_always' && !(Array.isArray(row.suggestions) && row.suggestions.length > 0)) {
    throw new AppError('VALIDATION', "Le CLI n'a proposé aucune règle « toujours » pour cette demande.", {
      untouched: "Rien n'a été transmis au CLI.",
    });
  }

  const decision = decisionFromOption(input.optionId);
  const dto = await scope.runner.permissionDecision({
    params: { permissionId: scope.permissionId },
    body: {
      behavior: decision.behavior,
      always: decision.always,
      ...(decision.behavior === 'deny' && input.message ? { message: input.message } : {}),
      decidedByUserId: ctx.user.id,
    },
  });

  await auditIn(ctx, {
    action: PERMISSION_AUDIT_ACTION,
    summary: permissionAuditSummary({
      optionId: input.optionId,
      target: dto.target ?? row.target,
      toolName: dto.toolName,
      alwaysPrefix: alwaysPrefix(dto.alwaysLabel),
      projectName: row.projectName,
    }),
    targetType: 'session',
    targetId: row.sessionId,
    environmentId: scope.environmentId,
    metadata: {
      permissionId: scope.permissionId,
      projectId: row.projectId,
      tool: dto.toolName,
      target: dto.target,
      decision: input.optionId,
      status: dto.status,
      withMessage: Boolean(input.message),
    },
  });
  return dto;
}
