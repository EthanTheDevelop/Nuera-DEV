import 'server-only';
import { AppError } from '@/server/errors';
import { getProjectMcpTools, setProjectMcpServer } from '@/server/mcp';
import { requireProjectRow } from './queries';
import type { ProjectMcpToolView } from './types';

type Actor = { id: string };

/** Integrations page of a server (D1/D2 drawer), where a degraded server is reconnected. */
export function mcpServerHref(name: string): string {
  return `/integrations/mcp/${encodeURIComponent(name)}`;
}

/** D04 « Outils MCP du projet »: every registered server with its switch state for this project. */
export async function listProjectMcpTools(projectId: string): Promise<ProjectMcpToolView[]> {
  const tools = await getProjectMcpTools(projectId);
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
 * Enables / disables an MCP server for the project (sessions started or resumed afterwards). A
 * server that needs a reconnection cannot be switched ON from here: the owner reconnects it in
 * Intégrations first (M04 inference, D2). Audited by `setProjectMcpServer`.
 */
export async function setProjectMcpTool(projectId: string, server: string, enabled: boolean, actor: Actor): Promise<ProjectMcpToolView> {
  await requireProjectRow(projectId);
  const tools = await listProjectMcpTools(projectId);
  const tool = tools.find((item) => item.id === server || item.name === server);
  if (!tool) throw new AppError('NOT_FOUND', 'Serveur MCP introuvable.');
  if (enabled && tool.needsReconnect) {
    throw new AppError('CONFLICT', `${tool.label} doit être reconnecté dans Intégrations avant d'être activé.`, {
      untouched: 'Le serveur reste désactivé pour ce projet.',
    });
  }
  await setProjectMcpServer({ projectId, serverIdOrName: tool.id, enabled }, { actorUserId: actor.id });
  return { ...tool, enabled };
}
