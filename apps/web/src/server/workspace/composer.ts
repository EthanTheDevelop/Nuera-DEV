import 'server-only';
import { formatBytes } from '@nuera/shared/format';
import type {
  AttachmentDto,
  PermissionModeResult,
  SessionCommandResult,
} from '@nuera/shared/runner';
import {
  composerModelOptions,
  type ComposerPaletteData,
  type SwitchablePermissionMode,
} from '@/features/workspace/lib/composer';
import { AppError } from '@/server/errors';
import { listProjectMcpServers } from '@/server/mcp';
import { readDiagnostic } from '@/server/mcp/registry';
import { listSeenModels } from '@/server/preferences';
import { isRunnerUnavailable } from '@/server/runner/client';
import { assertCanDriveSession } from '@/server/sessions';
import type { RequestContext } from '@/server/tenancy/context';
import { auditIn } from '@/server/tenancy/scope';
import { requireSessionContext } from './access';

/**
 * Composer of the Workspace: « Joindre » (one file written by the runner under
 * `.nuera/pieces-jointes/` of the session's worktree, then referenced with `@<chemin>` in the
 * instruction), the model chip (`/model <alias>` typed into the CLI), the mode chip (Maj+Tab) and
 * the palette data (skills from the runner, MCP servers of the project, models). Same scoping as
 * every Workspace action: a session of the space, drivable by the account; audited.
 */

type WorkspaceCtx = Pick<RequestContext, 'user' | 'space' | 'environment'>;

export const COMPOSER_AUDIT_ACTIONS = {
  attachment: 'session.attachment',
  model: 'session.model',
  permissionMode: 'session.permission_mode',
} as const;

async function drivableSession(ctx: WorkspaceCtx, sessionId: string) {
  const context = await requireSessionContext(ctx, sessionId);
  assertCanDriveSession(ctx, context.scope);
  if (context.session.status === 'archived' || context.session.archivedAt) {
    throw new AppError('CONFLICT', "Session archivée : elle ne reçoit plus d'instruction.", {
      untouched: "Rien n'a été modifié.",
    });
  }
  return context;
}

/** « Joindre »: the bytes go to the runner of the session's server, which checks them again. */
export async function uploadAttachment(
  ctx: WorkspaceCtx,
  sessionId: string,
  file: { name: string; type: string; bytes: Uint8Array },
): Promise<AttachmentDto> {
  const { scope, session, project } = await drivableSession(ctx, sessionId);
  const dto = await scope.runner.sessionAttachment({
    params: { sessionId: scope.sessionId },
    body: {
      name: file.name,
      contentType: file.type,
      dataBase64: Buffer.from(file.bytes).toString('base64'),
    },
  });
  await auditIn(ctx, {
    action: COMPOSER_AUDIT_ACTIONS.attachment,
    summary: `Pièce jointe « ${dto.name} » (${formatBytes(dto.size)}) ajoutée à la session « ${session.title} » · ${project.name}`,
    targetType: 'session',
    targetId: scope.sessionId,
    environmentId: scope.environmentId,
    metadata: {
      projectId: project.id,
      path: dto.path,
      size: dto.size,
      kind: dto.kind,
      contentType: dto.contentType,
    },
  });
  return dto;
}

/** Model chip: typed into the idle CLI (`/model`), else `--model` of the next launch. */
export async function setSessionModel(
  ctx: WorkspaceCtx,
  sessionId: string,
  model: string,
): Promise<SessionCommandResult> {
  const { scope, session, project } = await drivableSession(ctx, sessionId);
  const result = await scope.runner.sessionCommand({
    params: { sessionId: scope.sessionId },
    body: { command: 'model', model },
  });
  await auditIn(ctx, {
    action: COMPOSER_AUDIT_ACTIONS.model,
    summary: `Modèle « ${model} » ${result.applied === 'live' ? 'appliqué' : 'choisi pour le prochain démarrage'} · session « ${session.title} » · ${project.name}`,
    targetType: 'session',
    targetId: scope.sessionId,
    environmentId: scope.environmentId,
    metadata: { projectId: project.id, model, applied: result.applied },
  });
  return result;
}

/** Mode chip: Maj+Tab in the live CLI until it shows the mode, else `--permission-mode` of the next launch. */
export async function setSessionPermissionMode(
  ctx: WorkspaceCtx,
  sessionId: string,
  mode: SwitchablePermissionMode,
): Promise<PermissionModeResult> {
  const { scope, session, project } = await drivableSession(ctx, sessionId);
  const result = await scope.runner.sessionPermissionMode({
    params: { sessionId: scope.sessionId },
    body: { mode },
  });
  await auditIn(ctx, {
    action: COMPOSER_AUDIT_ACTIONS.permissionMode,
    summary: `Mode « ${mode} » ${result.applied === 'live' ? 'appliqué dans le CLI' : 'choisi pour le prochain démarrage'} · session « ${session.title} » · ${project.name}`,
    targetType: 'session',
    targetId: scope.sessionId,
    environmentId: scope.environmentId,
    metadata: { projectId: project.id, mode, applied: result.applied, presses: result.presses },
  });
  return result;
}

/**
 * Palette « / »: skills listed by the runner (read-only), MCP servers enabled for the project (tools
 * of their last diagnostic), models (aliases + those the CLI reported in the space). A runner that
 * does not answer only empties the skills (with the reason).
 */
export async function getComposerPalette(
  ctx: WorkspaceCtx,
  sessionId: string,
): Promise<ComposerPaletteData> {
  const { scope, project } = await requireSessionContext(ctx, sessionId);
  const [skills, servers, seen] = await Promise.all([
    scope.runner
      .sessionSkills({ params: { sessionId: scope.sessionId } }, { timeoutMs: 8_000 })
      .then((r) => ({ list: r.skills, error: null as string | null }))
      .catch((error: unknown) => ({
        list: null,
        error: isRunnerUnavailable(error)
          ? `${scope.environmentName} ne répond pas : skills indisponibles.`
          : 'Les skills de ce worktree sont illisibles.',
      })),
    listProjectMcpServers(project.id),
    listSeenModels(ctx).catch(() => []),
  ]);
  const mcp = servers
    .filter((server) => server.enabled && server.isEnabled)
    .map((server) => ({
      name: server.name,
      label: server.label,
      tools: readDiagnostic(server).tools.slice(0, 100),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return {
    skills: skills.list,
    skillsError: skills.error,
    mcp,
    models: composerModelOptions(seen),
  };
}
