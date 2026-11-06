import 'server-only';
import { AppError } from '@/server/errors';
import { getProjectMcpTools, setProjectMcpServer } from '@/server/mcp';
import { requireProject, type ProjectContext, type ProjectHandle } from './access';
import type { ProjectMcpToolView } from './types';

/** Integrations page of a server (D1/D2 drawer), where a degraded server is reconnected. */
export function mcpServerHref(name: string): string {
  return `/integrations/mcp/${encodeURIComponent(name)}`;
}

/**
 * D04 « Outils MCP du projet »: every server of the registry of the project's space with its
 * switch state for this project. The project comes out of a space check (handle).
 */
export async function listProjectMcpTools(handle: Pick<ProjectHandle, 'row'>): Promise<ProjectMcpToolView[]> {
  const tools = await getProjectMcpTools({ spaceId: handle.row.spaceId, projectId: handle.row.id });
  return tools.map((tool) => ({
    id: tool.id,
    name: tool.name,
    label: tool.label,
    line: tool.line,
    enabled: tool.enabled,
    status: tool.status,
    needsReconnect: tool.needsReconnect,
    reconnectHref: mcpServerHref(tool.name),
  }));
}

/**
 * Enables / disables an MCP server for a project of the space (sessions started or resumed
 * afterwards). Only a server listed for that project (the registry of ITS space) can be switched:
 * any other id or name answers « Serveur MCP introuvable. ». A server that needs a reconnection
 * cannot be switched ON from here: the owner reconnects it in Intégrations first (M04 inference,
 * D2). Audited by `setProjectMcpServer`.
 */
export async function setProjectMcpTool(ctx: ProjectContext, projectId: string, server: string, enabled: boolean): Promise<ProjectMcpToolView> {
  const handle = await requireProject(ctx, projectId);
  const tools = await listProjectMcpTools(handle);
  const tool = tools.find((item) => item.id === server || item.name === server);
  if (!tool) throw new AppError('NOT_FOUND', 'Serveur MCP introuvable.');
  if (enabled && tool.needsReconnect) {
    throw new AppError('CONFLICT', `${tool.label} doit être reconnecté dans Intégrations avant d'être activé.`, {
      untouched: 'Le serveur reste désactivé pour ce projet.',
    });
  }
  // The space is passed explicitly: the registry re-checks that the server and the project are both in it.
  await setProjectMcpServer({ spaceId: ctx.space.id, projectId: handle.row.id, serverIdOrName: tool.id, enabled }, { actorUserId: ctx.user.id });
  return { ...tool, enabled };
}
