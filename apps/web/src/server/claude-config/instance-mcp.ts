import 'server-only';
import { randomUUID } from 'node:crypto';
import { instanceMcpServers, type InstanceMcpConfig } from '@nuera/db/schema';
import type { McpConfig } from '@nuera/shared/runner';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AdminActor } from '@/server/admin/common';
import { normalizeCoolifyBaseUrl } from '@/server/coolify/client';
import { inferAbilitiesFromTools } from '@/server/coolify';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { normalizeMcpUrl, UNEXPECTED_MCP_URL } from '@/server/mcp/headers';
import { probeMcpServer } from '@/server/mcp/probe';
import { isCredentialHeaderName, mcpServerNameSchema } from '@/server/mcp/registry';
import { audit } from '@/server/security/audit';
import { decryptJson, encryptJson, SecretScopes } from '@/server/security/crypto';
import { assertAllowedDestination } from '@/server/security/ssrf';
import {
  COOLIFY_ADMIN_MCP_NAME,
  RESERVED_MCP_NAMES,
  audienceSchema,
  coolifyPermissionRules,
  enforcementSchema,
  instanceCoolifyRefusal,
  type EffectiveClaudeConfig,
  type McpItem,
  type McpPermissionRules,
} from './model';
import { assertConfigWriter, bumpRevision, mcpItem, parseInput, recordVersion, STALE_ITEM, type Tx } from './store';
import { scheduleCommonConfigSync } from './sync';

/**
 * MCP servers of the instance (lot K1): added to the `--mcp-config` of every session whose account is
 * in their audience. No secret ever reaches a configuration file: an authenticated server carries
 * `headersHelper: 'nuera'` (existing contract) and the runner's helper asks the web for the headers of
 * the running session (`/api/internal/mcp-headers`), refused for an account outside the audience.
 *
 * « Coolify (administrateurs) » (`coolify-admin`): the instance Coolify, for the owner and the
 * administrators only (audience forced). Its tools are classified from the list its MCP server gives
 * for the token (a successful test is required before anything is served): reads allowed, secrets and
 * writes behind a permission request (`ask`), destructive tools refused (`deny`) unless the owner
 * offers them — still behind a request. Bypass mode is blocked for any session that receives it.
 */

type McpRow = typeof instanceMcpServers.$inferSelect;

export const NOT_FOUND_MCP = 'Serveur MCP introuvable.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "nom d'en-tête invalide");
const headerValue = z.string().min(1).max(4096).regex(/^[^\r\n]*$/, "valeur d'en-tête invalide");
const toolList = z.array(z.string().trim().regex(/^[A-Za-z0-9_.-]{1,128}$/, "nom d'outil invalide")).max(200);

const remoteUrl = z
  .url('adresse invalide')
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && process.env.NODE_ENV !== 'production';
  }, 'adresse https sans identifiants attendue');

const instanceName = mcpServerNameSchema.refine((name) => !RESERVED_MCP_NAMES.has(name), 'identifiant réservé à un serveur intégré');

const common = {
  label: z.string().trim().min(1, 'nom requis').max(60),
  description: z.string().trim().max(300).nullish(),
  audience: audienceSchema.default('all'),
  enforcement: enforcementSchema.default('default'),
  enabled: z.boolean().default(true),
};

export const createInstanceMcpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('custom'),
    name: instanceName,
    transport: z.enum(['http', 'sse']),
    url: remoteUrl,
    authKind: z.enum(['none', 'bearer', 'header']).default('none'),
    bearerToken: z.string().trim().min(1).max(4096).regex(/^\S+$/, 'jeton invalide').optional(),
    secretHeaders: z.record(headerName, headerValue).optional(),
    staticHeaders: z.record(headerName.refine((name) => !isCredentialHeaderName(name), 'en-tête secret : à enregistrer comme en-tête secret'), headerValue.max(1024)).optional(),
    denyTools: toolList.optional(),
    askTools: toolList.optional(),
    ...common,
  }),
  z.object({
    kind: z.literal('stdio'),
    name: instanceName,
    command: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_./@:\\-]+$/, 'commande sans espace ni caractère spécial attendue'),
    args: z.array(z.string().max(4096)).max(50).default([]),
    denyTools: toolList.optional(),
    askTools: toolList.optional(),
    ...common,
  }),
  z.object({
    kind: z.literal('coolify'),
    baseUrl: z.string().trim().max(300),
    token: z.string().trim().min(10, 'jeton trop court').max(500).regex(/^[\x21-\x7e]+$/, 'jeton invalide'),
    label: common.label.default('Coolify (administrateurs)'),
    description: common.description,
    enforcement: common.enforcement,
    enabled: common.enabled,
    allowWrite: z.boolean().default(false),
    allowDestructive: z.boolean().default(false),
  }),
]);
export type CreateInstanceMcpInput = z.input<typeof createInstanceMcpSchema>;

export const updateInstanceMcpSchema = z.object({
  label: common.label.optional(),
  description: common.description,
  audience: audienceSchema.optional(),
  enforcement: enforcementSchema.optional(),
  enabled: z.boolean().optional(),
  url: remoteUrl.optional(),
  baseUrl: z.string().trim().max(300).optional(),
  command: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_./@:\\-]+$/).optional(),
  args: z.array(z.string().max(4096)).max(50).optional(),
  /** New secret (bearer token, Coolify token); absent: kept. */
  token: z.string().trim().min(1).max(4096).regex(/^\S+$/, 'jeton invalide').optional(),
  secretHeaders: z.record(headerName, headerValue).optional(),
  denyTools: toolList.optional(),
  askTools: toolList.optional(),
  allowWrite: z.boolean().optional(),
  allowDestructive: z.boolean().optional(),
  expectedVersion: z.number().int().positive().optional(),
});

interface McpSecrets {
  headers?: Record<string, string>;
}

function readSecrets(row: Pick<McpRow, 'id' | 'secretsEncrypted'>): McpSecrets {
  if (!row.secretsEncrypted) return {};
  try {
    return decryptJson<McpSecrets>(row.secretsEncrypted, SecretScopes.instanceMcpServer(row.id));
  } catch {
    throw new AppError('INTERNAL', 'Les secrets de ce serveur MCP commun ne peuvent pas être déchiffrés.', { detail: 'Vérifiez APP_ENCRYPTION_KEY, puis enregistrez de nouveau le jeton.' });
  }
}

const mcpSnapshot = (row: McpRow) => ({
  name: row.name,
  label: row.label,
  description: row.description,
  kind: row.kind,
  transport: row.transport,
  url: row.url,
  command: row.command,
  args: row.args,
  authKind: row.authKind,
  secretKeys: row.secretKeys,
  config: row.config,
  audience: row.audience,
  enforcement: row.enforcement,
  enabled: row.enabled,
});

function coolifyBase(raw: string): string {
  const parsed = remoteUrl.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION', 'Adresse https de Coolify attendue.');
  return normalizeCoolifyBaseUrl(parsed.data);
}

/** Only the owner may offer destructive Coolify tools (even behind a request). */
function assertDestructiveAllowed(actor: AdminActor, requested: boolean | undefined): void {
  if (requested && actor.role !== 'owner') {
    throw new AppError('FORBIDDEN', "Seul le propriétaire de l'instance peut proposer les outils destructifs de Coolify.");
  }
}

async function journal(actor: AdminActor, action: string, summary: string, row: Pick<McpRow, 'id'>, metadata: Record<string, unknown>): Promise<void> {
  await audit({ action: `instance.claude_${action}`, summary, actorUserId: actor.id, targetType: 'claude_mcp', targetId: row.id, metadata });
}

async function findRow(executor: Tx | typeof db, id: string, lock = false): Promise<McpRow> {
  if (!UUID.test(id)) throw new AppError('NOT_FOUND', NOT_FOUND_MCP);
  const query = executor.select().from(instanceMcpServers).where(eq(instanceMcpServers.id, id)).limit(1);
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new AppError('NOT_FOUND', NOT_FOUND_MCP);
  return row;
}

export async function createInstanceMcp(actor: AdminActor, input: unknown): Promise<McpItem> {
  assertConfigWriter(actor);
  const data = parseInput(createInstanceMcpSchema, input, 'Serveur MCP invalide.');
  const id = randomUUID();
  let values: typeof instanceMcpServers.$inferInsert;
  if (data.kind === 'coolify') {
    assertDestructiveAllowed(actor, data.allowDestructive);
    const base = coolifyBase(data.baseUrl);
    await assertAllowedDestination(base);
    values = {
      id,
      name: COOLIFY_ADMIN_MCP_NAME,
      label: data.label,
      description: data.description ?? 'Coolify de l\'instance, pour le propriétaire et les administrateurs.',
      kind: 'coolify',
      transport: 'http',
      url: base,
      authKind: 'bearer',
      secretsEncrypted: encryptJson({ headers: { Authorization: `Bearer ${data.token}` } } satisfies McpSecrets, SecretScopes.instanceMcpServer(id)),
      secretKeys: ['Authorization'],
      config: { allowWrite: data.allowWrite, allowDestructive: data.allowWrite && data.allowDestructive },
      audience: 'admins',
      enforcement: data.enforcement,
      enabled: data.enabled,
    };
  } else if (data.kind === 'custom') {
    await assertAllowedDestination(data.url);
    const headers: Record<string, string> =
      data.authKind === 'bearer' ? (data.bearerToken ? { Authorization: `Bearer ${data.bearerToken}` } : {}) : data.authKind === 'header' ? { ...(data.secretHeaders ?? {}) } : {};
    if (data.authKind !== 'none' && Object.keys(headers).length === 0) throw new AppError('VALIDATION', 'Jeton ou en-têtes secrets requis pour ce mode d\'authentification.');
    values = {
      id,
      name: data.name,
      label: data.label,
      description: data.description ?? null,
      kind: 'custom',
      transport: data.transport,
      url: data.url,
      authKind: data.authKind,
      secretsEncrypted: Object.keys(headers).length ? encryptJson({ headers } satisfies McpSecrets, SecretScopes.instanceMcpServer(id)) : null,
      secretKeys: Object.keys(headers),
      config: { headers: data.staticHeaders ?? {}, denyTools: data.denyTools ?? [], askTools: data.askTools ?? [] },
      audience: data.audience,
      enforcement: data.enforcement,
      enabled: data.enabled,
    };
  } else {
    values = {
      id,
      name: data.name,
      label: data.label,
      description: data.description ?? null,
      kind: 'custom',
      transport: 'stdio',
      command: data.command,
      args: data.args,
      authKind: 'none',
      config: { denyTools: data.denyTools ?? [], askTools: data.askTools ?? [] },
      audience: data.audience,
      enforcement: data.enforcement,
      enabled: data.enabled,
    };
  }
  const { row, revision } = await db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: instanceMcpServers.id }).from(instanceMcpServers).where(eq(instanceMcpServers.name, values.name)).limit(1);
    if (existing) throw new AppError('CONFLICT', `Un serveur MCP commun s'appelle déjà « ${values.name} ».`);
    const [created] = await tx.insert(instanceMcpServers).values({ ...values, createdByUserId: actor.id, updatedByUserId: actor.id }).returning();
    await recordVersion(tx, actor, { kind: 'mcp', itemId: id, label: created!.label, version: 1, action: 'created', snapshot: mcpSnapshot(created!) });
    return { row: created!, revision: await bumpRevision(tx, actor) };
  });
  await journal(actor, 'mcp_created', `serveur MCP commun ajouté : « ${row.label} » (${row.name})`, row, {
    revision,
    kind: row.kind,
    audience: row.audience,
    transport: row.transport,
    secretKeys: row.secretKeys,
    ...(row.kind === 'coolify' ? { allowWrite: row.config.allowWrite ?? false, allowDestructive: row.config.allowDestructive ?? false } : {}),
  });
  scheduleCommonConfigSync();
  return mcpItem(row);
}

export async function updateInstanceMcp(actor: AdminActor, id: string, input: unknown): Promise<McpItem> {
  assertConfigWriter(actor);
  const data = parseInput(updateInstanceMcpSchema, input, 'Serveur MCP invalide.');
  assertDestructiveAllowed(actor, data.allowDestructive);
  const current = await findRow(db, id);
  if (data.expectedVersion !== undefined && current.version !== data.expectedVersion) throw new AppError('CONFLICT', STALE_ITEM);
  const patch: Partial<typeof instanceMcpServers.$inferInsert> = {};
  if (data.label !== undefined) patch.label = data.label;
  if (data.description !== undefined) patch.description = data.description ?? null;
  if (data.enforcement !== undefined) patch.enforcement = data.enforcement;
  if (data.enabled !== undefined) patch.enabled = data.enabled;
  if (data.audience !== undefined) {
    if (current.kind === 'coolify' && data.audience !== 'admins') throw new AppError('VALIDATION', 'Coolify reste réservé aux administrateurs.');
    patch.audience = data.audience;
  }
  let reverify = false;
  if (current.kind === 'coolify') {
    if (data.baseUrl !== undefined) {
      const base = coolifyBase(data.baseUrl);
      await assertAllowedDestination(base);
      if (base !== current.url) reverify = true;
      patch.url = base;
    }
    const config: InstanceMcpConfig = { ...current.config };
    if (data.allowWrite !== undefined) config.allowWrite = data.allowWrite;
    if (data.allowDestructive !== undefined) config.allowDestructive = data.allowDestructive;
    if (!config.allowWrite) config.allowDestructive = false;
    patch.config = config;
    if (data.token !== undefined) {
      patch.secretsEncrypted = encryptJson({ headers: { Authorization: `Bearer ${data.token}` } } satisfies McpSecrets, SecretScopes.instanceMcpServer(current.id));
      patch.secretKeys = ['Authorization'];
      reverify = true;
    }
  } else {
    if (data.url !== undefined) {
      if (current.transport === 'stdio') throw new AppError('VALIDATION', "Un serveur stdio n'a pas d'adresse.");
      await assertAllowedDestination(data.url);
      patch.url = data.url;
    }
    if (data.command !== undefined || data.args !== undefined) {
      if (current.transport !== 'stdio') throw new AppError('VALIDATION', "Seul un serveur stdio a une commande.");
      if (data.command !== undefined) patch.command = data.command;
      if (data.args !== undefined) patch.args = data.args;
    }
    if (data.token !== undefined || data.secretHeaders !== undefined) {
      const headers = data.token !== undefined ? { Authorization: `Bearer ${data.token}` } : { ...(data.secretHeaders ?? {}) };
      patch.secretsEncrypted = Object.keys(headers).length ? encryptJson({ headers } satisfies McpSecrets, SecretScopes.instanceMcpServer(current.id)) : null;
      patch.secretKeys = Object.keys(headers);
      patch.authKind = data.token !== undefined ? 'bearer' : Object.keys(headers).length ? 'header' : 'none';
    }
    if (data.denyTools !== undefined || data.askTools !== undefined) {
      patch.config = { ...current.config, ...(data.denyTools ? { denyTools: data.denyTools } : {}), ...(data.askTools ? { askTools: data.askTools } : {}) };
    }
  }
  if (reverify) {
    // A new token or address is unverified until the next successful test (never served before).
    patch.abilities = [];
    patch.abilitiesSource = null;
    patch.lastTools = [];
    patch.status = 'unknown';
  }
  if (Object.keys(patch).length === 0) return mcpItem(current);
  const { row, revision } = await db.transaction(async (tx) => {
    const locked = await findRow(tx, id, true);
    if (locked.version !== current.version) throw new AppError('CONFLICT', STALE_ITEM);
    const [updated] = await tx
      .update(instanceMcpServers)
      .set({ ...patch, version: locked.version + 1, updatedByUserId: actor.id })
      .where(eq(instanceMcpServers.id, locked.id))
      .returning();
    await recordVersion(tx, actor, { kind: 'mcp', itemId: locked.id, label: updated!.label, version: updated!.version, action: 'updated', snapshot: mcpSnapshot(updated!) });
    return { row: updated!, revision: await bumpRevision(tx, actor) };
  });
  await journal(actor, 'mcp_updated', `serveur MCP commun modifié : « ${row.label} » (version ${row.version})`, row, {
    revision,
    version: row.version,
    changed: Object.keys(patch).filter((key) => key !== 'secretsEncrypted'),
    secretChanged: patch.secretsEncrypted !== undefined,
  });
  scheduleCommonConfigSync();
  return mcpItem(row);
}

export async function deleteInstanceMcp(actor: AdminActor, id: string): Promise<void> {
  assertConfigWriter(actor);
  const { row, revision } = await db.transaction(async (tx) => {
    const current = await findRow(tx, id, true);
    await tx.delete(instanceMcpServers).where(eq(instanceMcpServers.id, current.id));
    await recordVersion(tx, actor, { kind: 'mcp', itemId: id, label: current.label, version: current.version + 1, action: 'deleted', snapshot: mcpSnapshot(current) });
    return { row: current, revision: await bumpRevision(tx, actor) };
  });
  await journal(actor, 'mcp_deleted', `serveur MCP commun supprimé : « ${row.label} » (${row.name})`, row, { revision });
  scheduleCommonConfigSync();
}

/** A deleted server cannot come back from a snapshot: its secrets are gone (snapshots hold none). */
export async function rollbackMcpSnapshot(
  tx: Tx,
  actor: AdminActor,
  itemId: string,
  snapshot: Record<string, unknown>,
  fromVersion: number,
): Promise<{ itemId: string; version: number; label: string }> {
  const [current] = await tx.select().from(instanceMcpServers).where(eq(instanceMcpServers.id, itemId)).limit(1).for('update');
  if (!current) throw new AppError('CONFLICT', 'Ce serveur MCP a été supprimé : ajoutez-le de nouveau (ses secrets ne sont jamais conservés dans les versions).');
  const restored = z
    .object({
      label: z.string().min(1).max(60),
      description: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
      command: z.string().nullable().optional(),
      args: z.array(z.string()).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      audience: audienceSchema.optional(),
      enforcement: enforcementSchema.optional(),
      enabled: z.boolean().optional(),
    })
    .parse(snapshot);
  if (restored.url && restored.url !== current.url) await assertAllowedDestination(restored.url);
  const urlChanged = (restored.url ?? null) !== current.url;
  const [row] = await tx
    .update(instanceMcpServers)
    .set({
      label: restored.label,
      description: restored.description ?? null,
      url: current.transport === 'stdio' ? null : (restored.url ?? current.url),
      command: restored.command ?? current.command,
      args: restored.args ?? current.args,
      config: (restored.config as InstanceMcpConfig | undefined) ?? current.config,
      audience: current.kind === 'coolify' ? 'admins' : (restored.audience ?? current.audience),
      enforcement: restored.enforcement ?? current.enforcement,
      enabled: restored.enabled ?? current.enabled,
      version: current.version + 1,
      updatedByUserId: actor.id,
      ...(current.kind === 'coolify' && urlChanged ? { abilities: [], abilitiesSource: null, lastTools: [], status: 'unknown' as const } : {}),
    })
    .where(eq(instanceMcpServers.id, current.id))
    .returning();
  await recordVersion(tx, actor, { kind: 'mcp', itemId, label: row!.label, version: row!.version, action: 'rolled_back', snapshot: { ...mcpSnapshot(row!), fromVersion } });
  return { itemId, version: row!.version, label: row!.label };
}

export interface McpTestResult {
  server: McpItem;
  ok: boolean;
  tools: string[];
  message: string | null;
  /** Coolify: the permission rules the sessions will receive. */
  rules: McpPermissionRules | null;
}

/**
 * « Tester la connexion »: `initialize` + `tools/list` with the stored credential (never returned).
 * The listed tools are what the permission rules are built from; for Coolify, the abilities of the
 * token are read from them (`abilities_source = 'mcp_tools'`, the condition to serve it).
 */
export async function testInstanceMcp(actor: AdminActor, id: string, options: { fetchImpl?: typeof fetch } = {}): Promise<McpTestResult> {
  assertConfigWriter(actor);
  const current = await findRow(db, id);
  if (current.transport === 'stdio') {
    throw new AppError('CONFLICT', "Un serveur stdio démarre sur chaque serveur avec la session : il ne se teste pas depuis le web.");
  }
  const url = current.kind === 'coolify' ? `${current.url}/mcp` : current.url;
  if (!url) throw new AppError('CONFLICT', 'Adresse absente.');
  const headers = { ...(current.config.headers ?? {}), ...(readSecrets(current).headers ?? {}) };
  const probe = await probeMcpServer({ url, headers, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  const ok = probe.outcome === 'ok';
  const patch: Partial<typeof instanceMcpServers.$inferInsert> = {
    lastCheckedAt: new Date(),
    status: ok ? 'connected' : probe.outcome === 'unauthorized' || probe.outcome === 'forbidden' ? 'needs_auth' : 'error',
    lastError: ok ? null : (probe.message ?? `Test échoué (${probe.outcome}).`).slice(0, 300),
    ...(ok ? { lastTools: probe.tools } : {}),
  };
  if (current.kind === 'coolify' && ok) {
    const inferred = inferAbilitiesFromTools(probe.tools);
    patch.abilities = inferred.abilities;
    patch.abilitiesSource = 'mcp_tools';
  }
  const [row] = await db.update(instanceMcpServers).set(patch).where(eq(instanceMcpServers.id, current.id)).returning();
  const item = mcpItem(row!);
  await journal(actor, 'mcp_tested', `serveur MCP commun testé : « ${row!.label} » · ${ok ? `${probe.tools.length} outils` : 'échec'}`, row!, {
    ok,
    outcome: probe.outcome,
    tools: probe.tools.length,
    ...(current.kind === 'coolify' ? { abilities: patch.abilities ?? current.abilities } : {}),
  });
  // Tools (and Coolify abilities) feed the permission rules of the next sessions.
  if (ok) scheduleCommonConfigSync();
  return {
    server: item,
    ok,
    tools: probe.tools,
    message: ok ? null : patch.lastError ?? null,
    rules: current.kind === 'coolify' ? coolifyPermissionRules(row!.name, row!.lastTools, row!.config) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Sessions: entries of --mcp-config, permission rules, headers
// ---------------------------------------------------------------------------------------------

type ServerEntry = McpConfig['mcpServers'][string];

export interface InstanceMcpSessionParts {
  servers: Record<string, ServerEntry>;
  rules: McpPermissionRules;
  skipped: Array<{ name: string; reason: string }>;
  /** A server that can act on production (Coolify) is present: bypass mode is blocked. */
  blockBypass: boolean;
}

/** Entries for the applied instance servers of an account (computeEffective decides who gets what). */
export function instanceMcpSessionParts(effective: Pick<EffectiveClaudeConfig, 'mcp'>, items: readonly McpItem[]): InstanceMcpSessionParts {
  const parts: InstanceMcpSessionParts = { servers: {}, rules: { allow: [], ask: [], deny: [] }, skipped: [], blockBypass: false };
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const applied of effective.mcp) {
    const item = byId.get(applied.id);
    if (!item || !applied.applied) continue;
    if (applied.unavailable) {
      parts.skipped.push({ name: item.name, reason: applied.unavailable });
      continue;
    }
    if (item.kind === 'coolify') {
      parts.servers[item.name] = { type: 'http', url: `${item.url}/mcp`, headersHelper: 'nuera' };
      const rules = coolifyPermissionRules(item.name, item.lastTools, item.config);
      parts.rules.allow.push(...rules.allow);
      parts.rules.ask.push(...rules.ask);
      parts.rules.deny.push(...rules.deny);
      parts.blockBypass = true;
      continue;
    }
    if (item.transport === 'stdio') {
      parts.servers[item.name] = { type: 'stdio', command: item.command!, args: item.args };
    } else {
      const staticHeaders = Object.fromEntries(Object.entries(item.config.headers ?? {}).filter(([name]) => !isCredentialHeaderName(name)));
      parts.servers[item.name] = {
        type: item.transport === 'sse' ? 'sse' : 'http',
        url: item.url!,
        ...(Object.keys(staticHeaders).length ? { headers: staticHeaders } : {}),
        ...(item.hasSecrets ? { headersHelper: 'nuera' as const } : {}),
      };
    }
    for (const tool of item.config.denyTools ?? []) parts.rules.deny.push(`mcp__${item.name}__${tool}`);
    for (const tool of item.config.askTools ?? []) parts.rules.ask.push(`mcp__${item.name}__${tool}`);
  }
  return parts;
}

/**
 * Headers of an instance server for a live session whose account the server applies to (the caller
 * resolved the account and its effective configuration). The URL Claude Code reports must be the
 * server's (pinned). Coolify is re-checked (refusal) at every call.
 */
export async function instanceMcpHeaders(input: {
  effective: Pick<EffectiveClaudeConfig, 'mcp'>;
  serverName: string;
  serverUrl?: string | null;
}): Promise<{ headers: Record<string, string>; expiresAt: string | null } | null> {
  const applied = input.effective.mcp.find((server) => server.name === input.serverName && server.applied);
  if (!applied) return null;
  const row = await findRow(db, applied.id);
  if (!row.enabled) throw new AppError('FORBIDDEN', 'Serveur MCP commun désactivé.');
  const item = mcpItem(row);
  if (item.kind === 'coolify') {
    const refusal = instanceCoolifyRefusal(item);
    if (refusal) throw new AppError('FORBIDDEN', refusal);
  }
  const expected = item.kind === 'coolify' ? `${item.url}/mcp` : item.url;
  if (input.serverUrl) {
    if (!expected || normalizeMcpUrl(input.serverUrl) !== normalizeMcpUrl(expected)) throw new AppError('FORBIDDEN', UNEXPECTED_MCP_URL);
  }
  return { headers: { ...(readSecrets(row).headers ?? {}) }, expiresAt: null };
}
