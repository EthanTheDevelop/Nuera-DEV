import 'server-only';
import { mcpServers, projectMcpServers, projects } from '@nuera/db/schema';
import type { McpAuthKind, McpStatus, McpTransport } from '@nuera/db/schema';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { STATUS_BADGES, type CheckHistoryEntry, type IntegrationCheck } from '@/server/integrations/model';
import { audit } from '@/server/security/audit';
import { decryptJson, encryptJson } from '@/server/security/crypto';
import { MCP_PRESETS, MCP_PRESET_IDS, isPresetName, presetOf, type McpCredentialSource, type McpPermissionLine, type McpPresetId } from './presets';

/**
 * Registry of the MCP servers offered to Claude Code sessions (table `mcp_servers`) and their
 * per-project activation (`project_mcp_servers`). Secret headers are stored ENCRYPTED and only
 * their names (`secret_keys`) are exposed; they reach Claude through the headers helper.
 */

export type McpServerRow = typeof mcpServers.$inferSelect;

/** Shape of `mcp_servers.last_diagnostic` (written by the diagnostics). */
export interface McpDiagnosticRecord {
  last: IntegrationCheck | null;
  history: CheckHistoryEntry[];
  consecutiveFailures: number;
  failingSince: string | null;
  tools: string[];
  serverInfo: { name: string; version: string | null } | null;
}

export function readDiagnostic(row: Pick<McpServerRow, 'lastDiagnostic'>): McpDiagnosticRecord {
  const value = (row.lastDiagnostic ?? {}) as Partial<McpDiagnosticRecord>;
  return {
    last: value.last ?? null,
    history: Array.isArray(value.history) ? value.history : [],
    consecutiveFailures: typeof value.consecutiveFailures === 'number' ? value.consecutiveFailures : 0,
    failingSince: typeof value.failingSince === 'string' ? value.failingSince : null,
    tools: Array.isArray(value.tools) ? value.tools.filter((tool): tool is string => typeof tool === 'string') : [],
    serverInfo: value.serverInfo ?? null,
  };
}

interface McpSecrets {
  headers?: Record<string, string>;
}

export function readServerSecrets(row: Pick<McpServerRow, 'secretsEncrypted'>): McpSecrets {
  if (!row.secretsEncrypted) return {};
  try {
    return decryptJson<McpSecrets>(row.secretsEncrypted);
  } catch {
    throw new AppError('INTERNAL', 'Les en-têtes secrets de ce serveur MCP ne peuvent pas être déchiffrés.', {
      detail: 'Vérifiez APP_ENCRYPTION_KEY, puis enregistrez de nouveau les en-têtes.',
    });
  }
}

/** Where the server's credential comes from. */
export function credentialSourceOf(row: Pick<McpServerRow, 'name' | 'authKind' | 'secretsEncrypted'>): McpCredentialSource {
  const preset = presetOf(row.name);
  if (preset) return preset.credential;
  if (row.authKind === 'oauth') return 'claude_oauth';
  if ((row.authKind === 'bearer' || row.authKind === 'header') && row.secretsEncrypted) return 'stored_headers';
  return 'none';
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export const mcpServerNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'identifiant en minuscules, chiffres et tirets (40 caractères max)');

const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "nom d'en-tête invalide");
const headerValue = z.string().min(1).max(4096).regex(/^[^\r\n]*$/, "valeur d'en-tête invalide");

const httpsUrl = z
  .url('adresse invalide')
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    if (url.protocol === 'https:') return !url.username && !url.password;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'http:' && loopback && process.env.NODE_ENV !== 'production';
  }, 'adresse https sans identifiants attendue');

const common = {
  name: mcpServerNameSchema.refine((value) => !isPresetName(value), 'identifiant réservé à un serveur intégré'),
  label: z.string().trim().min(1, 'nom requis').max(60),
  description: z.string().trim().max(200).optional().nullable(),
  icon: z.string().trim().regex(/^[a-z0-9-]{1,40}$/).optional().nullable(),
  scopeNote: z.string().trim().max(300).optional().nullable(),
  permissionsNote: z.string().trim().max(300).optional().nullable(),
};

export const createMcpServerInputSchema = z.discriminatedUnion('transport', [
  z.object({
    ...common,
    transport: z.enum(['http', 'sse']),
    url: httpsUrl,
    authKind: z.enum(['none', 'bearer', 'header', 'oauth']).default('none'),
    /** authKind = bearer → sent as `Authorization: Bearer <token>` by the headers helper. */
    bearerToken: z.string().trim().min(1).max(4096).regex(/^[^\s]+$/, 'jeton invalide').optional(),
    /** authKind = header → secret headers (all stored encrypted). */
    headers: z.record(headerName, headerValue).optional(),
  }),
  z.object({
    ...common,
    transport: z.literal('stdio'),
    command: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_./@:\\-]+$/, 'commande sans espace ni caractère spécial attendue'),
    args: z.array(z.string().max(4096)).max(50).default([]),
    authKind: z.literal('none').default('none'),
  }),
]);
export type CreateMcpServerInput = z.input<typeof createMcpServerInputSchema>;

export const updateMcpServerInputSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(200).nullable().optional(),
  icon: z.string().trim().regex(/^[a-z0-9-]{1,40}$/).nullable().optional(),
  url: httpsUrl.optional(),
  command: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_./@:\\-]+$/).optional(),
  args: z.array(z.string().max(4096)).max(50).optional(),
  scopeNote: z.string().trim().max(300).nullable().optional(),
  permissionsNote: z.string().trim().max(300).nullable().optional(),
  isEnabled: z.boolean().optional(),
  /** Replaces the secret headers (custom HTTP servers). `null` removes them. */
  bearerToken: z.string().trim().min(1).max(4096).regex(/^[^\s]+$/).nullable().optional(),
  headers: z.record(headerName, headerValue).nullable().optional(),
});
export type UpdateMcpServerInput = z.input<typeof updateMcpServerInputSchema>;

// ---------------------------------------------------------------------------------------------
// Presets (seeded once, idempotent)
// ---------------------------------------------------------------------------------------------

/** Inserts the built-in servers that do not exist yet (status `unknown`, enabled in no project). */
export async function ensurePresetServers(): Promise<void> {
  const rows = MCP_PRESET_IDS.map((id) => {
    const preset = MCP_PRESETS[id];
    return {
      name: preset.id,
      label: preset.label,
      description: preset.description,
      icon: preset.icon,
      transport: preset.transport,
      url: preset.url ?? null,
      command: preset.command ?? null,
      args: preset.args ?? [],
      authKind: preset.authKind,
      scopeNote: preset.scopeNote,
      permissionsNote: preset.permissionsNote,
      isEnabled: true,
      status: 'unknown' as McpStatus,
    };
  });
  await db.insert(mcpServers).values(rows).onConflictDoNothing({ target: mcpServers.name });
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

export interface McpProjectActivation {
  id: string;
  name: string;
  enabled: boolean;
}

export type McpServerAction =
  | { kind: 'activate'; label: 'Activer' }
  | { kind: 'configure'; label: 'Configurer' }
  | { kind: 'reconnect'; label: 'Reconnecter'; via: 'mcp_login' | 'coolify_token' | 'github_app' | 'headers' };

export interface McpServerView {
  id: string;
  name: string;
  label: string;
  description: string | null;
  subtitle: string | null;
  projectLine: string | null;
  icon: string | null;
  preset: McpPresetId | null;
  transport: McpTransport;
  authKind: McpAuthKind;
  credential: McpCredentialSource;
  /** Display URL (no credential inside). */
  url: string | null;
  command: string | null;
  args: string[];
  isEnabled: boolean;
  /** Last diagnostic result. */
  status: McpStatus;
  /** What the card shows: `disabled` when enabled in no project. */
  displayStatus: McpStatus;
  badge: { label: string; tone: 'success' | 'danger' | 'warn' | 'neutral' };
  projectCount: number;
  projects: McpProjectActivation[];
  secretKeys: string[];
  scopeNote: string | null;
  permissionsNote: string | null;
  permissions: McpPermissionLine[];
  configurationLines: string[];
  denyRules: string[];
  toolCount: number | null;
  lastCheckedAt: string | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  failingSince: string | null;
  expiresAt: string | null;
  syncedToCliAt: string | null;
  /** D1 « Dernier appel »: latest `mcp__<name>__*` tool call seen by the hook bridge. */
  lastCall: McpLastCall | null;
  action: McpServerAction;
  lastCheck: IntegrationCheck | null;
  history: CheckHistoryEntry[];
}

export interface McpLastCall {
  at: string;
  tool: string;
  projectId: string;
  projectName: string;
  ok: boolean;
}

function actionFor(row: McpServerRow, displayStatus: McpStatus, credential: McpCredentialSource): McpServerAction {
  if (displayStatus === 'disabled') return { kind: 'activate', label: 'Activer' };
  if (displayStatus === 'expired' || displayStatus === 'needs_auth') {
    const via =
      credential === 'claude_oauth'
        ? 'mcp_login'
        : credential === 'coolify_token'
          ? 'coolify_token'
          : credential === 'github_installation'
            ? 'github_app'
            : 'headers';
    return { kind: 'reconnect', label: 'Reconnecter', via };
  }
  return { kind: 'configure', label: 'Configurer' };
}

export function toServerView(
  row: McpServerRow,
  activations: McpProjectActivation[],
  options: { coolifyBaseUrl?: string | null; lastCall?: McpLastCall | null } = {},
): McpServerView {
  const preset = presetOf(row.name);
  const credential = credentialSourceOf(row);
  const projectCount = activations.filter((item) => item.enabled).length;
  const displayStatus: McpStatus = !row.isEnabled || projectCount === 0 ? 'disabled' : row.status;
  const diagnostic = readDiagnostic(row);
  const url = preset?.id === 'coolify' ? (options.coolifyBaseUrl ? `${options.coolifyBaseUrl}/mcp` : null) : row.url;
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    description: row.description,
    subtitle: preset?.subtitle ?? null,
    projectLine: preset?.projectLine ?? row.description,
    icon: row.icon,
    preset: preset?.id ?? null,
    transport: row.transport,
    authKind: row.authKind,
    credential,
    url,
    command: row.command,
    args: row.args,
    isEnabled: row.isEnabled,
    status: row.status,
    displayStatus,
    badge: STATUS_BADGES[displayStatus],
    projectCount,
    projects: activations,
    secretKeys: row.secretKeys,
    scopeNote: row.scopeNote,
    permissionsNote: row.permissionsNote,
    permissions: preset?.permissions ?? [],
    configurationLines: preset?.configurationLines ?? [
      'configuration générée par Nuera Dev pour chaque session',
      `transport : ${row.transport === 'stdio' ? 'stdio' : 'HTTP distant'}`,
      `authentification : ${row.authKind === 'oauth' ? 'autorisation OAuth dans Claude Code' : row.secretKeys.length ? 'en-têtes chiffrés sur VPS-3' : 'aucune'}`,
    ],
    denyRules: preset?.denyRules ?? [],
    toolCount: diagnostic.tools.length ? diagnostic.tools.length : null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastLatencyMs: row.lastLatencyMs,
    lastError: row.lastError,
    failingSince: diagnostic.failingSince,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    syncedToCliAt: row.syncedToCliAt?.toISOString() ?? null,
    lastCall: options.lastCall ?? null,
    action: actionFor(row, displayStatus, credential),
    lastCheck: diagnostic.last,
    history: diagnostic.history,
  };
}

async function activationsByServer(): Promise<Map<string, McpProjectActivation[]>> {
  const rows = await db
    .select({
      projectId: projects.id,
      projectName: projects.name,
      serverId: projectMcpServers.mcpServerId,
      enabled: projectMcpServers.enabled,
    })
    .from(projects)
    .leftJoin(projectMcpServers, eq(projectMcpServers.projectId, projects.id))
    .where(isNull(projects.archivedAt))
    .orderBy(asc(projects.name));
  const allProjects = new Map<string, string>();
  const enabledBy = new Map<string, Map<string, boolean>>();
  for (const row of rows) {
    allProjects.set(row.projectId, row.projectName);
    if (row.serverId) {
      const map = enabledBy.get(row.serverId) ?? new Map<string, boolean>();
      map.set(row.projectId, row.enabled ?? false);
      enabledBy.set(row.serverId, map);
    }
  }
  const servers = await db.select({ id: mcpServers.id }).from(mcpServers);
  const result = new Map<string, McpProjectActivation[]>();
  for (const server of servers) {
    const map = enabledBy.get(server.id);
    result.set(
      server.id,
      [...allProjects.entries()].map(([id, name]) => ({ id, name, enabled: map?.get(id) ?? false })),
    );
  }
  return result;
}

/**
 * Latest MCP tool call per server name, from the conversation events written by the runner's hook
 * bridge (`session_events.kind = 'tool'`, payload.tool = `mcp__<server>__<tool>`).
 */
export async function lastCallsByServer(): Promise<Map<string, McpLastCall>> {
  const rows = await db.execute(sql`
    select distinct on (split_part(e.payload->>'tool', '__', 2))
      split_part(e.payload->>'tool', '__', 2) as server,
      e.payload->>'tool' as tool,
      e.payload->>'status' as status,
      e.updated_at as at,
      p.id as project_id,
      p.name as project_name
    from session_events e
    join sessions s on s.id = e.session_id
    join projects p on p.id = s.project_id
    where e.kind = 'tool' and e.payload->>'tool' like 'mcp\\_\\_%'
    order by split_part(e.payload->>'tool', '__', 2), e.updated_at desc
  `);
  const result = new Map<string, McpLastCall>();
  for (const raw of rows as unknown as Array<Record<string, unknown>>) {
    const server = String(raw.server ?? '');
    if (!server) continue;
    const at = raw.at instanceof Date ? raw.at.toISOString() : new Date(String(raw.at)).toISOString();
    result.set(server, {
      at,
      tool: String(raw.tool ?? ''),
      projectId: String(raw.project_id ?? ''),
      projectName: String(raw.project_name ?? ''),
      ok: raw.status !== 'error' && raw.status !== 'denied',
    });
  }
  return result;
}

export async function listMcpServers(options: { coolifyBaseUrl?: string | null; seedPresets?: boolean } = {}): Promise<McpServerView[]> {
  if (options.seedPresets !== false) await ensurePresetServers();
  const rows = await db.select().from(mcpServers).orderBy(asc(mcpServers.createdAt), asc(mcpServers.name));
  const [activations, lastCalls] = await Promise.all([activationsByServer(), lastCallsByServer()]);
  const presetOrder = (name: string) => (isPresetName(name) ? MCP_PRESET_IDS.indexOf(name) : MCP_PRESET_IDS.length);
  return rows
    .sort((a, b) => presetOrder(a.name) - presetOrder(b.name))
    .map((row) => toServerView(row, activations.get(row.id) ?? [], { ...options, lastCall: lastCalls.get(row.name) ?? null }));
}

export async function getMcpServerRow(idOrName: string): Promise<McpServerRow | null> {
  const isUuid = z.uuid().safeParse(idOrName).success;
  const find = async () => {
    const [row] = await db
      .select()
      .from(mcpServers)
      .where(isUuid ? eq(mcpServers.id, idOrName) : eq(mcpServers.name, idOrName))
      .limit(1);
    return row ?? null;
  };
  const row = await find();
  if (row || isUuid || !isPresetName(idOrName)) return row;
  // Built-in servers exist as soon as someone asks for them (first toggle in D1 / D04).
  await ensurePresetServers();
  return find();
}

export async function getMcpServer(idOrName: string, options: { coolifyBaseUrl?: string | null } = {}): Promise<McpServerView> {
  const row = await getMcpServerRow(idOrName);
  if (!row) throw new AppError('NOT_FOUND', 'Serveur MCP introuvable.');
  const [activations, lastCalls] = await Promise.all([activationsByServer(), lastCallsByServer()]);
  return toServerView(row, activations.get(row.id) ?? [], { ...options, lastCall: lastCalls.get(row.name) ?? null });
}

// ---------------------------------------------------------------------------------------------
// Mutations (audited)
// ---------------------------------------------------------------------------------------------

function secretPayload(input: { bearerToken?: string | null | undefined; headers?: Record<string, string> | null | undefined }): {
  secretsEncrypted: string | null;
  secretKeys: string[];
} | null {
  if (input.bearerToken === undefined && input.headers === undefined) return null;
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  if (input.bearerToken) headers.Authorization = `Bearer ${input.bearerToken}`;
  const keys = Object.keys(headers);
  return keys.length ? { secretsEncrypted: encryptJson({ headers }), secretKeys: keys } : { secretsEncrypted: null, secretKeys: [] };
}

export async function createMcpServer(input: CreateMcpServerInput, options: { actorUserId?: string | null } = {}): Promise<McpServerView> {
  const data = createMcpServerInputSchema.parse(input);
  if (await getMcpServerRow(data.name)) throw new AppError('CONFLICT', `Un serveur MCP « ${data.name} » existe déjà.`);
  const values: typeof mcpServers.$inferInsert = {
    name: data.name,
    label: data.label,
    description: data.description ?? null,
    icon: data.icon ?? null,
    transport: data.transport,
    scopeNote: data.scopeNote ?? null,
    permissionsNote: data.permissionsNote ?? null,
    authKind: data.authKind,
    status: 'unknown',
  };
  if (data.transport === 'stdio') {
    values.command = data.command;
    values.args = data.args;
  } else {
    values.url = data.url;
    if (data.authKind === 'bearer' && !data.bearerToken) throw new AppError('VALIDATION', 'Jeton requis pour une authentification Bearer.');
    if (data.authKind === 'header' && !Object.keys(data.headers ?? {}).length) throw new AppError('VALIDATION', 'Au moins un en-tête est requis.');
    const secrets = secretPayload({
      bearerToken: data.authKind === 'bearer' ? data.bearerToken : undefined,
      headers: data.authKind === 'header' ? data.headers : undefined,
    });
    if (secrets) Object.assign(values, secrets);
  }
  const [row] = await db.insert(mcpServers).values(values).returning();
  if (!row) throw new AppError('INTERNAL', 'Création du serveur MCP impossible.');
  await audit({
    action: 'integration.mcp.created',
    summary: `serveur MCP « ${row.label} » ajouté (${row.transport})`,
    targetType: 'mcp_server',
    targetId: row.id,
    actorUserId: options.actorUserId ?? null,
    metadata: { name: row.name, transport: row.transport, authKind: row.authKind, secretKeys: row.secretKeys },
  });
  return getMcpServer(row.id);
}

export async function updateMcpServer(
  idOrName: string,
  input: UpdateMcpServerInput,
  options: { actorUserId?: string | null } = {},
): Promise<McpServerView> {
  const data = updateMcpServerInputSchema.parse(input);
  const row = await getMcpServerRow(idOrName);
  if (!row) throw new AppError('NOT_FOUND', 'Serveur MCP introuvable.');
  const preset = presetOf(row.name);
  if (preset && (data.url !== undefined || data.command !== undefined || data.args !== undefined || data.bearerToken !== undefined || data.headers !== undefined)) {
    throw new AppError('VALIDATION', "La configuration d'un serveur intégré ne se modifie pas.", {
      detail: preset.credential === 'coolify_token' ? 'Pour Coolify, utilisez « Reconnecter ».' : undefined,
    });
  }
  if (row.transport === 'stdio' && (data.url !== undefined || data.bearerToken !== undefined || data.headers !== undefined)) {
    throw new AppError('VALIDATION', "Un serveur stdio n'a ni adresse ni en-têtes.");
  }
  if (row.transport !== 'stdio' && (data.command !== undefined || data.args !== undefined)) {
    throw new AppError('VALIDATION', "Un serveur HTTP n'a pas de commande.");
  }
  const patch: Partial<typeof mcpServers.$inferInsert> = {};
  for (const key of ['label', 'description', 'icon', 'url', 'command', 'args', 'scopeNote', 'permissionsNote', 'isEnabled'] as const) {
    if (data[key] !== undefined) (patch as Record<string, unknown>)[key] = data[key];
  }
  const secrets = secretPayload({ bearerToken: data.bearerToken, headers: data.headers });
  if (secrets) {
    Object.assign(patch, secrets);
    // Removing the headers of an OAuth server keeps its OAuth grant (held by Claude Code).
    patch.authKind = secrets.secretKeys.length ? (data.bearerToken ? 'bearer' : 'header') : row.authKind === 'oauth' ? 'oauth' : 'none';
  }
  if (Object.keys(patch).length === 0) return getMcpServer(row.id);
  // A changed endpoint or credential invalidates the last diagnostic.
  if (patch.url !== undefined || patch.command !== undefined || patch.args !== undefined || secrets) patch.status = 'unknown';
  await db.update(mcpServers).set(patch).where(eq(mcpServers.id, row.id));
  await audit({
    action: secrets ? 'integration.mcp.credentials_updated' : 'integration.mcp.updated',
    summary: `serveur MCP « ${patch.label ?? row.label} » modifié${secrets ? ' (en-têtes secrets remplacés)' : ''}`,
    targetType: 'mcp_server',
    targetId: row.id,
    actorUserId: options.actorUserId ?? null,
    metadata: { fields: Object.keys(patch).filter((key) => key !== 'secretsEncrypted') },
  });
  return getMcpServer(row.id);
}

export async function deleteMcpServer(idOrName: string, options: { actorUserId?: string | null } = {}): Promise<{ name: string }> {
  const row = await getMcpServerRow(idOrName);
  if (!row) throw new AppError('NOT_FOUND', 'Serveur MCP introuvable.');
  if (isPresetName(row.name)) {
    throw new AppError('VALIDATION', 'Un serveur intégré ne se supprime pas : désactivez-le partout.');
  }
  await db.delete(mcpServers).where(eq(mcpServers.id, row.id));
  await audit({
    action: 'integration.mcp.deleted',
    summary: `serveur MCP « ${row.label} » supprimé`,
    targetType: 'mcp_server',
    targetId: row.id,
    actorUserId: options.actorUserId ?? null,
    metadata: { name: row.name },
  });
  return { name: row.name };
}

/** D1 « ACTIVÉ DANS » toggle / D04 « Outils MCP du projet ». */
export async function setProjectMcpServer(
  input: { projectId: string; serverIdOrName: string; enabled: boolean },
  options: { actorUserId?: string | null } = {},
): Promise<McpServerView> {
  const row = await getMcpServerRow(input.serverIdOrName);
  if (!row) throw new AppError('NOT_FOUND', 'Serveur MCP introuvable.');
  const [project] = await db
    .select({ id: projects.id, name: projects.name, archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!project) throw new AppError('NOT_FOUND', 'Projet introuvable.');
  if (project.archivedAt) throw new AppError('CONFLICT', 'Ce projet est archivé.');
  await db
    .insert(projectMcpServers)
    .values({ projectId: project.id, mcpServerId: row.id, enabled: input.enabled })
    .onConflictDoUpdate({
      target: [projectMcpServers.projectId, projectMcpServers.mcpServerId],
      set: { enabled: input.enabled },
    });
  await audit({
    action: input.enabled ? 'integration.mcp.project_enabled' : 'integration.mcp.project_disabled',
    summary: `serveur MCP « ${row.label} » ${input.enabled ? 'activé' : 'désactivé'} pour ${project.name}`,
    targetType: 'mcp_server',
    targetId: row.id,
    actorUserId: options.actorUserId ?? null,
    metadata: { projectId: project.id },
  });
  return getMcpServer(row.id);
}

/** D1 « Désactiver partout » (sensitive bulk action, confirmed in the UI). */
export async function disableMcpServerEverywhere(
  serverIdOrName: string,
  options: { actorUserId?: string | null } = {},
): Promise<{ server: McpServerView; disabledProjects: number }> {
  const row = await getMcpServerRow(serverIdOrName);
  if (!row) throw new AppError('NOT_FOUND', 'Serveur MCP introuvable.');
  const updated = await db
    .update(projectMcpServers)
    .set({ enabled: false })
    .where(and(eq(projectMcpServers.mcpServerId, row.id), eq(projectMcpServers.enabled, true)))
    .returning({ projectId: projectMcpServers.projectId });
  await audit({
    action: 'integration.mcp.disabled_everywhere',
    summary: `serveur MCP « ${row.label} » désactivé partout (${updated.length} projet${updated.length > 1 ? 's' : ''})`,
    targetType: 'mcp_server',
    targetId: row.id,
    actorUserId: options.actorUserId ?? null,
  });
  return { server: await getMcpServer(row.id), disabledProjects: updated.length };
}

export interface ProjectMcpTool {
  id: string;
  name: string;
  label: string;
  /** « maquettes · lecture », « issues et pull requests du dépôt »… */
  line: string | null;
  enabled: boolean;
  status: McpStatus;
  badge: McpServerView['badge'];
  /** « à reconnecter » (D04 warn text) when the server needs the owner. */
  needsReconnect: boolean;
  action: McpServerAction;
}

/** D04 « Outils MCP du projet »: every server with its switch state for this project. */
export async function getProjectMcpTools(projectId: string, options: { coolifyBaseUrl?: string | null } = {}): Promise<ProjectMcpTool[]> {
  const servers = await listMcpServers(options);
  return servers.map((server) => {
    const enabled = server.projects.find((item) => item.id === projectId)?.enabled ?? false;
    const needsReconnect = server.status === 'expired' || server.status === 'needs_auth';
    return {
      id: server.id,
      name: server.name,
      label: server.label,
      line: server.projectLine,
      enabled,
      status: server.status,
      badge: STATUS_BADGES[enabled ? server.status : 'disabled'],
      needsReconnect,
      action: server.action,
    };
  });
}

/** MCP servers enabled for one project (D04), with the session-relevant fields. */
export async function listProjectMcpServers(projectId: string): Promise<Array<McpServerRow & { enabled: boolean }>> {
  const rows = await db
    .select({ server: mcpServers, enabled: projectMcpServers.enabled })
    .from(projectMcpServers)
    .innerJoin(mcpServers, eq(mcpServers.id, projectMcpServers.mcpServerId))
    .where(eq(projectMcpServers.projectId, projectId));
  return rows.map((row) => ({ ...row.server, enabled: row.enabled }));
}

/** Number of projects where each server is enabled (D07 Neutre badge « 3 projets »). */
export async function countActiveProjectsByServer(): Promise<Map<string, number>> {
  const rows = await db
    .select({ serverId: projectMcpServers.mcpServerId, n: sql<number>`count(*)::int` })
    .from(projectMcpServers)
    .innerJoin(projects, eq(projects.id, projectMcpServers.projectId))
    .where(and(eq(projectMcpServers.enabled, true), isNull(projects.archivedAt)))
    .groupBy(projectMcpServers.mcpServerId);
  return new Map(rows.map((row) => [row.serverId, Number(row.n)]));
}
