import 'server-only';

/**
 * MCP registry for Claude Code sessions (research §5–§6) — public API. One registry per space
 * (MULTICOMPTE §7); the built-in servers are ensured whenever a registry is read.
 *
 *   buildSessionMcpConfig(projectId) → { mcpConfig, denyRules, env, skipped }     (no secret inside)
 *   listMcpServers({ spaceId }) / getMcpServer({ spaceId, idOrName: 'figma' })    (D07 grid, D1/D2 drawers)
 *   setProjectMcpServer({ spaceId, projectId, serverIdOrName, enabled })          (« ACTIVÉ DANS », D04)
 *   checkMcpServer({ spaceId, idOrName: 'coolify' })                              (« Tester la connexion »)
 *   startMcpLogin(ctx, 'figma')                                                   (terminal on the space's server, owner only)
 *   resolveSessionMcpHeaders({ sessionId, serverName, environmentId, serverUrl }) (POST /api/internal/mcp-headers)
 */

export { buildSessionMcpConfig, SESSION_MCP_ENV, type SessionMcpConfig } from './session-config';
export {
  listMcpServers,
  getMcpServer,
  getMcpServerRow,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  setProjectMcpServer,
  disableMcpServerEverywhere,
  listProjectMcpServers,
  getProjectMcpTools,
  lastCallsByServer,
  countActiveProjectsByServer,
  ensurePresetServers,
  MCP_SERVER_NOT_FOUND,
  createMcpServerInputSchema,
  updateMcpServerInputSchema,
  mcpServerNameSchema,
  type McpServerView,
  type McpServerAction,
  type McpProjectActivation,
  type McpLastCall,
  type ProjectMcpTool,
  type CreateMcpServerInput,
  type UpdateMcpServerInput,
  type McpServerScope,
  type McpViewOptions,
} from './registry';
export {
  checkMcpServer,
  checkActiveMcpServers,
  startMcpLogin,
  requireMcpLoginServer,
  MCP_LOGIN_OWNER_ONLY,
  SERVER_DISABLED_MESSAGE,
  syncMcpServersToCli,
  statusFromCli,
  runnerPortFor,
  runnerPortOfSpace,
  serverOfSpace,
  resetCliMcpState,
  NO_SERVER_MESSAGE,
  type McpRunnerPort,
  type SpaceServer,
} from './diagnostics';
export { resolveSessionMcpHeaders, LIVE_SESSION_STATUSES, GITHUB_MCP_PERMISSIONS, UNEXPECTED_MCP_URL, type SessionMcpHeaders } from './headers';
export { probeMcpServer, probeOAuthEndpoint, type McpProbeResult } from './probe';
export {
  MCP_PRESETS,
  MCP_PRESET_IDS,
  FIGMA_WRITE_TOOLS,
  COOLIFY_MUTATING_TOOLS,
  PLAYWRIGHT_MCP_VERSION,
  isPresetName,
  encryptedWhere,
  presetText,
  type PresetServerContext,
  type McpPreset,
  type McpPresetId,
} from './presets';
