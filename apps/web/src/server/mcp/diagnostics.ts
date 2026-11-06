import 'server-only';
import type { McpCliStatus, TerminalDto } from '@nuera/shared/runner';
import { environments, mcpServers } from '@nuera/db/schema';
import type { EnvironmentStatus, McpStatus } from '@nuera/db/schema';
import { and, asc, desc, eq, inArray, isNotNull, ne, or } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { inferAbilitiesFromTools } from '@/server/coolify';
import { getStoredCoolify, updateCoolify } from '@/server/coolify/store';
import {
  applyHysteresis,
  newCheckId,
  pushHistory,
  startTimer,
  type CheckAction,
  type CheckStep,
  type CheckTrigger,
  type IntegrationCheck,
} from '@/server/integrations/model';
import { sanitizeText } from '@/server/integrations/redact';
import { applyHealthTransition, healthOfMcpStatus } from '@/server/integrations/transitions';
import { getRunnerForEnvironment } from '@/server/runner/client';
import { audit } from '@/server/security/audit';
import type { EnvironmentRef, RequestContext } from '@/server/tenancy/context';
import { auditIn } from '@/server/tenancy/scope';
import { resolveDiagnosticHeaders } from './headers';
import { presetOf, type PresetServerContext } from './presets';
import { probeMcpServer, probeOAuthEndpoint, type McpProbeResult } from './probe';
import {
  countActiveProjectsByServer,
  credentialSourceOf,
  getMcpServer,
  getMcpServerRow,
  readDiagnostic,
  staticHeadersOf,
  MCP_SERVER_NOT_FOUND,
  type McpDiagnosticRecord,
  type McpServerRow,
  type McpServerScope,
  type McpServerView,
} from './registry';

/**
 * Non-mutating diagnostics of MCP servers (research §5.6):
 *  - HTTP servers with a Nuera credential (GitHub, Coolify, custom headers): `initialize` + `tools/list`
 *    with the same credential a session would get;
 *  - OAuth servers (Figma) and stdio servers (Playwright): `claude mcp get <name>` through the runner
 *    of the space's server (Claude Code owns the OAuth grant; Nuera Dev never reads it), plus an
 *    unauthenticated reachability probe for OAuth endpoints. The CLI state belongs to that server
 *    (one server per space): a space without server keeps these servers « à tester ».
 */

/** Same copy as NO_ENVIRONMENT_MESSAGE (server/tenancy/context, not imported: it loads the auth stack). */
export const NO_SERVER_MESSAGE = "Aucun serveur ne vous est encore attribué : un administrateur doit vous en attribuer un.";

/**
 * Same copy as LOGIN_TERMINAL_OWNER_ONLY (server/terminals, not imported: it loads the session
 * stack, which imports this module): a login terminal belongs to the owner of the space only.
 */
export const MCP_LOGIN_OWNER_ONLY = "Seul le propriétaire de l'espace peut connecter Claude Code sur son serveur.";

/** Same copy as the runner's ENVIRONMENT_DISABLED refusal (apps/runner/src/environment.ts). */
export const SERVER_DISABLED_MESSAGE = 'Ce serveur est désactivé : aucune nouvelle session, aucun clonage ni aucune commande ne peut démarrer.';

/** `untouched` of a refused login terminal (same as server/terminals). */
const LOGIN_UNTOUCHED = 'Aucun terminal ouvert.';

/** Runner calls used here (injectable in tests). */
export interface McpRunnerPort {
  mcpGet(name: string): Promise<McpCliStatus>;
  mcpSync(input: { upsert: Array<{ name: string; config: Record<string, unknown> }>; remove: string[] }): Promise<{
    results: Array<{ name: string; action: 'upsert' | 'remove'; ok: boolean; raw: string }>;
  }>;
  createLoginTerminal(serverName: string, actorUserId?: string | null): Promise<TerminalDto>;
}

/** Server (runner) of a space: the one that is not retired (one per space, MULTICOMPTE §3.1). */
export interface SpaceServer extends PresetServerContext {
  id: string;
  status: EnvironmentStatus;
}

export async function serverOfSpace(spaceId: string): Promise<SpaceServer | null> {
  const [row] = await db
    .select({ id: environments.id, name: environments.name, isDefault: environments.isDefault, status: environments.status })
    .from(environments)
    .where(and(eq(environments.spaceId, spaceId), isNotNull(environments.spaceId), ne(environments.status, 'retired')))
    .orderBy(desc(eq(environments.status, 'active')), asc(environments.createdAt))
    .limit(1);
  return row ?? null;
}

/** Runner calls on one server (the runner client of that environment). */
export function runnerPortFor(environmentId: string): McpRunnerPort {
  const client = getRunnerForEnvironment(environmentId);
  return {
    mcpGet: (name) => client.claudeMcpGet({ params: { name } }),
    mcpSync: (input) => client.claudeMcpSync({ body: input }),
    createLoginTerminal: (serverName, actorUserId) =>
      client.createTerminal({ body: { kind: 'mcp-login', serverName, ...(actorUserId ? { actorUserId } : {}) } }),
  };
}

/** Port of the server of the space, or null when the space has none. */
export async function runnerPortOfSpace(spaceId: string): Promise<McpRunnerPort | null> {
  const server = await serverOfSpace(spaceId);
  return server ? runnerPortFor(server.id) : null;
}

const IMPACTS: Record<string, string> = {
  figma: "Les sessions n'ont plus accès aux maquettes Figma.",
  github: "Les sessions n'ont plus accès aux issues et pull requests GitHub.",
  coolify: "Les sessions n'ont plus accès aux environnements de développement.",
  playwright: "Les sessions n'ont plus de navigateur de test.",
};

function impactOf(row: McpServerRow): string {
  return IMPACTS[row.name] ?? `Les sessions n'ont plus accès au serveur MCP ${row.label}.`;
}

/** Servers whose state is read through the CLI (and therefore need a user-scope entry). */
export function usesCliDiagnostics(row: Pick<McpServerRow, 'name' | 'transport' | 'authKind' | 'secretsEncrypted'>): boolean {
  return row.transport === 'stdio' || credentialSourceOf(row) === 'claude_oauth';
}

/** User-scope config written by `claude mcp add-json --scope user` (no secret: CLI-diagnosed servers only). */
export function cliConfigOf(row: McpServerRow): Record<string, unknown> | null {
  if (row.transport === 'stdio') return row.command ? { type: 'stdio', command: row.command, args: row.args } : null;
  if (credentialSourceOf(row) === 'claude_oauth' && row.url) return { type: row.transport === 'sse' ? 'sse' : 'http', url: row.url };
  return null;
}

/**
 * Writes/removes the user-scope entries of CLI-diagnosed servers of the space on the space's server
 * (best effort, runner may be down). `port` null: the space has no server (nothing written).
 */
export async function syncMcpServersToCli(
  input: { spaceId: string; upsert?: McpServerRow[]; remove?: string[] },
  port?: McpRunnerPort | null,
): Promise<{ ok: boolean; results: Array<{ name: string; ok: boolean; raw: string }>; error: string | null }> {
  const upsert = (input.upsert ?? [])
    .filter((row) => row.spaceId === input.spaceId)
    .filter(usesCliDiagnostics)
    .map((row) => ({ name: row.name, config: cliConfigOf(row) }))
    .filter((item): item is { name: string; config: Record<string, unknown> } => item.config !== null);
  const remove = input.remove ?? [];
  if (upsert.length === 0 && remove.length === 0) return { ok: true, results: [], error: null };
  const target = port === undefined ? await runnerPortOfSpace(input.spaceId) : port;
  if (!target) return { ok: false, results: [], error: NO_SERVER_MESSAGE };
  try {
    const result = await target.mcpSync({ upsert, remove });
    const synced = result.results.filter((item) => item.ok && item.action === 'upsert').map((item) => item.name);
    if (synced.length) {
      await db
        .update(mcpServers)
        .set({ syncedToCliAt: new Date() })
        .where(and(eq(mcpServers.spaceId, input.spaceId), inArray(mcpServers.name, synced)));
    }
    return {
      ok: result.results.every((item) => item.ok),
      results: result.results.map((item) => ({ name: item.name, ok: item.ok, raw: sanitizeText(item.raw, 2_000) ?? '' })),
      error: null,
    };
  } catch (error) {
    return { ok: false, results: [], error: error instanceof AppError ? error.message : "Le runner n'a pas pu synchroniser Claude Code." };
  }
}

/** Maps `claude mcp get` (parsed by the runner) to the registry status. */
export function statusFromCli(cli: Pick<McpCliStatus, 'state'>, previous: McpStatus): { status: McpStatus; reason?: string; transient?: boolean } {
  switch (cli.state) {
    case 'connected':
      return { status: 'connected' };
    case 'needs_auth':
      return {
        status: previous === 'connected' || previous === 'expired' ? 'expired' : 'needs_auth',
        reason: previous === 'connected' || previous === 'expired' ? 'Autorisation expirée' : 'Connexion requise dans Claude Code.',
      };
    case 'failed':
      return { status: 'error', reason: 'Claude Code ne parvient pas à joindre le serveur.', transient: true };
    case 'pending':
      return { status: 'error', reason: "Serveur en attente d'approbation dans Claude Code." };
    case 'rejected':
      return { status: 'error', reason: 'Serveur refusé dans Claude Code.' };
    case 'blocked':
      return { status: 'error', reason: 'Serveur bloqué par une politique gérée.' };
    case 'disabled':
      return { status: 'disabled', reason: 'Désactivé dans Claude Code.' };
    case 'not_configured':
      return { status: 'unknown', reason: 'Serveur absent de la configuration de Claude Code.' };
    default:
      return { status: 'error', reason: 'État inconnu renvoyé par Claude Code.' };
  }
}

function statusFromProbe(
  probe: McpProbeResult,
  context: { previous: McpStatus; credentialSent: boolean; everConnected: boolean; name: string },
): { status: McpStatus; reason: string; transient: boolean } {
  switch (probe.outcome) {
    case 'ok':
      return { status: 'connected', reason: '', transient: false };
    case 'unauthorized':
      return context.credentialSent && (context.everConnected || context.name === 'coolify')
        ? { status: 'expired', reason: 'Autorisation expirée', transient: false }
        : { status: 'needs_auth', reason: 'Connexion requise.', transient: false };
    case 'forbidden':
      return { status: 'error', reason: probe.message ?? 'Accès refusé par le serveur MCP.', transient: false };
    case 'not_found':
      return { status: 'error', reason: 'Serveur MCP désactivé ou adresse erronée.', transient: false };
    case 'protocol_error':
      return { status: 'error', reason: probe.message ?? 'Réponse MCP inattendue.', transient: false };
    default:
      return { status: 'error', reason: probe.outcome === 'timeout' ? 'Le serveur MCP ne répond pas (délai dépassé).' : 'Serveur MCP injoignable.', transient: true };
  }
}

function reconnectAction(row: McpServerRow): CheckAction | undefined {
  switch (credentialSourceOf(row)) {
    case 'claude_oauth':
      return { label: 'Reconnecter', kind: 'terminal' };
    case 'coolify_token':
      return { label: 'Reconnecter', kind: 'form' };
    case 'github_installation':
      return { label: 'Réautoriser sur GitHub', kind: 'internal', url: '/integrations' };
    case 'stored_headers':
      return { label: 'Remplacer les en-têtes', kind: 'form' };
    default:
      return undefined;
  }
}

const lastManualChecks = globalThis as unknown as { __nueraMcpLastManual?: Map<string, number> };

export interface CheckMcpOptions {
  trigger?: CheckTrigger;
  /** Runner calls (default: the server of the space; null: no server). */
  port?: McpRunnerPort | null;
  fetchImpl?: typeof fetch;
  actorUserId?: string | null;
  /** Scheduled run: skip a server checked less than this long ago. */
  skipCheckedWithinMs?: number;
}

/** Forgets the manual-check throttles (tests). */
export function resetMcpCheckState(): void {
  lastManualChecks.__nueraMcpLastManual?.clear();
}

export async function checkMcpServer(scope: McpServerScope, options: CheckMcpOptions = {}): Promise<McpServerView> {
  const trigger = options.trigger ?? 'manual';
  const row = await getMcpServerRow(scope);
  if (!row) throw new AppError('NOT_FOUND', MCP_SERVER_NOT_FOUND);
  const server = await serverOfSpace(row.spaceId);
  const port = options.port !== undefined ? options.port : server ? runnerPortFor(server.id) : null;
  const viewOptions = { server };
  if (trigger === 'manual') {
    const map = (lastManualChecks.__nueraMcpLastManual ??= new Map());
    // A replaced secret or address resets the status to `unknown`: that test always runs.
    if (row.status !== 'unknown' && Date.now() - (map.get(row.id) ?? 0) < 10_000) return getMcpServer({ spaceId: row.spaceId, idOrName: row.id }, viewOptions);
    map.set(row.id, Date.now());
  }
  if (options.skipCheckedWithinMs && row.lastCheckedAt && Date.now() - row.lastCheckedAt.getTime() < options.skipCheckedWithinMs) {
    return getMcpServer({ spaceId: row.spaceId, idOrName: row.id }, viewOptions);
  }
  if (usesCliDiagnostics(row) && !port) {
    // No server: Claude Code cannot be asked. The server stays « à tester », without notification.
    await db
      .update(mcpServers)
      .set({ status: 'unknown', lastError: NO_SERVER_MESSAGE })
      .where(and(eq(mcpServers.id, row.id), eq(mcpServers.spaceId, row.spaceId)));
    return getMcpServer({ spaceId: row.spaceId, idOrName: row.id }, viewOptions);
  }

  const startedAt = new Date();
  const total = startTimer();
  const diagnostic: McpDiagnosticRecord = readDiagnostic(row);
  const previous = row.status;
  const steps: CheckStep[] = [];
  let next: McpStatus = 'connected';
  let reason = '';
  let transient = false;
  let latency: number | null = null;
  let tools = diagnostic.tools;
  let serverInfo = diagnostic.serverInfo;
  const preset = presetOf(row.name);
  const coolify = preset?.id === 'coolify' ? await getStoredCoolify(row.spaceId) : null;
  const url = preset?.id === 'coolify' ? (coolify ? `${coolify.config.baseUrl}/mcp` : null) : row.url;

  if (usesCliDiagnostics(row)) {
    if (credentialSourceOf(row) === 'claude_oauth' && url) {
      const reach = await probeOAuthEndpoint(url, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
      const { reachable, ...step } = reach;
      steps.push(step);
      latency = step.ms;
      if (!reachable) {
        next = 'error';
        reason = 'Serveur MCP injoignable.';
        transient = true;
      }
    }
    if (next !== 'error') {
      const timer = startTimer();
      try {
        let cli = await port!.mcpGet(row.name);
        if (cli.state === 'not_configured') {
          const sync = await syncMcpServersToCli({ spaceId: row.spaceId, upsert: [row] }, port);
          steps.push({ name: `claude mcp add-json --scope user ${row.name}`, ok: sync.ok, ms: timer(), ...(sync.error ? { providerMessage: sync.error } : {}) });
          if (sync.ok) cli = await port!.mcpGet(row.name);
        }
        steps.push({
          name: `claude mcp get ${row.name}`,
          ok: cli.state === 'connected',
          ms: timer(),
          ...(cli.statusLine ? { providerMessage: sanitizeText(cli.statusLine, 200) } : {}),
          raw: sanitizeText(cli.raw, 4_000) ?? '',
        });
        const mapped = statusFromCli(cli, previous);
        next = mapped.status;
        reason = mapped.reason ?? '';
        transient = mapped.transient ?? false;
      } catch (error) {
        steps.push({ name: `claude mcp get ${row.name}`, ok: false, ms: timer(), providerMessage: error instanceof AppError ? error.message : 'Runner injoignable.' });
        // Our own infrastructure, not the server: keep the previous state (transient).
        next = 'error';
        reason = 'Vérification impossible : le runner ne répond pas.';
        transient = true;
      }
    }
  } else if (!url) {
    next = 'needs_auth';
    reason = preset?.id === 'coolify' ? "Coolify n'est pas connecté." : 'Adresse absente.';
  } else {
    const credential = await resolveDiagnosticHeaders(row);
    if (credential.missing) {
      next = 'needs_auth';
      reason = credential.missing;
      steps.push({ name: 'Identifiants', ok: false, ms: 0, providerMessage: credential.missing });
    } else {
      const probe = await probeMcpServer({
        url,
        headers: { ...staticHeadersOf(row), ...credential.headers },
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      steps.push(...probe.steps);
      latency = probe.durationMs;
      if (probe.outcome === 'ok') {
        tools = probe.tools;
        serverInfo = probe.serverInfo;
      }
      const mapped = statusFromProbe(probe, {
        previous,
        credentialSent: Object.keys(credential.headers).length > 0,
        everConnected: diagnostic.history.some((entry) => entry.status === 'connected') || previous === 'connected',
        name: row.name,
      });
      next = mapped.status;
      reason = mapped.reason;
      transient = mapped.transient;
      if (preset?.id === 'coolify' && coolify && probe.outcome === 'ok') {
        // The Coolify MCP server only lists the tools the token may use: record the abilities read
        // here (they gate the headers helper, P4) and refuse a token that can write.
        const inferred = inferAbilitiesFromTools(probe.tools);
        await updateCoolify(row.spaceId, (config) =>
          config.connectedAt === coolify.config.connectedAt
            ? { ...config, abilities: inferred.abilities, abilitiesSource: 'mcp_tools', mcpEnabled: true, mcpToolCount: probe.tools.length }
            : config,
        ).catch(() => undefined);
        if (inferred.write) {
          next = 'error';
          reason = 'Ce jeton Coolify peut modifier Coolify (droit write) : reconnectez Coolify avec un jeton limité à read et read:sensitive.';
          transient = false;
        }
      }
    }
  }

  const failed = next === 'error' || next === 'expired' || next === 'needs_auth';
  const consecutiveFailures = failed ? diagnostic.consecutiveFailures + 1 : 0;
  const status = applyHysteresis<McpStatus>({ previous, next, transient, consecutiveFailures });
  const failingSince = failed ? (diagnostic.failingSince ?? startedAt.toISOString()) : null;
  const action = next === 'expired' || next === 'needs_auth' ? reconnectAction(row) : undefined;
  const check: IntegrationCheck = {
    id: newCheckId(),
    target: `mcp:${row.name}`,
    trigger,
    startedAt: startedAt.toISOString(),
    durationMs: total(),
    steps,
    result: { status: next, ...(reason ? { reason } : {}), ...(action ? { action } : {}) },
  };
  const record: McpDiagnosticRecord = {
    last: check,
    history: pushHistory(diagnostic.history, check),
    consecutiveFailures,
    failingSince,
    tools,
    serverInfo,
  };
  await db
    .update(mcpServers)
    .set({
      status,
      lastCheckedAt: startedAt,
      lastLatencyMs: latency,
      lastError: failed ? reason || null : null,
      lastDiagnostic: record as unknown as Record<string, unknown>,
      ...(preset?.id === 'coolify' ? { expiresAt: coolify?.config.declaredExpiresAt ? new Date(coolify.config.declaredExpiresAt) : null } : {}),
    })
    .where(and(eq(mcpServers.id, row.id), eq(mcpServers.spaceId, row.spaceId)));

  // Only servers used by at least one project raise notifications (to the members of the space).
  const counts = await countActiveProjectsByServer(row.spaceId);
  if ((counts.get(row.id) ?? 0) > 0 && row.isEnabled) {
    await applyHealthTransition({
      spaceId: row.spaceId,
      target: `mcp:${row.name}`,
      label: row.label,
      previous: healthOfMcpStatus(previous),
      next: healthOfMcpStatus(status),
      failingSince: failingSince ? new Date(failingSince) : null,
      impact: impactOf(row),
      reason: reason || null,
      href: `/integrations/mcp/${row.name}`,
    });
  }
  if (trigger === 'manual' && options.actorUserId) {
    await audit({
      action: 'integration.mcp.checked',
      summary: `serveur MCP « ${row.label} » vérifié : ${status}`,
      targetType: 'mcp_server',
      targetId: row.id,
      actorUserId: options.actorUserId,
      spaceId: row.spaceId,
    });
  }
  return getMcpServer({ spaceId: row.spaceId, idOrName: row.id }, viewOptions);
}

/** Checks every server of the space used by at least one of its projects (scheduler, every 15 min). */
export async function checkActiveMcpServers(
  options: CheckMcpOptions & { spaceId: string },
): Promise<Array<{ name: string; status: McpStatus | 'failed'; error?: string }>> {
  const counts = await countActiveProjectsByServer(options.spaceId);
  const rows = await db.select().from(mcpServers).where(eq(mcpServers.spaceId, options.spaceId));
  const active = rows.filter((row) => row.isEnabled && (counts.get(row.id) ?? 0) > 0);
  const results = await Promise.allSettled(
    active.map((row) => checkMcpServer({ spaceId: options.spaceId, idOrName: row.id }, { ...options, trigger: options.trigger ?? 'schedule' })),
  );
  return results.map((result, index) =>
    result.status === 'fulfilled'
      ? { name: active[index]!.name, status: result.value.status }
      : { name: active[index]!.name, status: 'failed' as const, error: result.reason instanceof Error ? result.reason.message : 'erreur' },
  );
}

/**
 * Server of the space for a `claude mcp login` terminal — the check of requireLoginTerminalServer
 * (server/terminals), plus the server's state: AppError CONFLICT NO_ENVIRONMENT without a server,
 * FORBIDDEN for anyone but the owner of the space (one server = one person = one Claude connection,
 * MULTICOMPTE §1.2), FORBIDDEN ENVIRONMENT_DISABLED for a suspended (or retired) server.
 */
export function requireMcpLoginServer(ctx: Pick<RequestContext, 'space' | 'environment'>): EnvironmentRef {
  const environment = ctx.environment;
  if (!environment) throw new AppError('CONFLICT', NO_SERVER_MESSAGE, { reason: 'NO_ENVIRONMENT' });
  if (ctx.space.role !== 'owner') throw new AppError('FORBIDDEN', MCP_LOGIN_OWNER_ONLY, { untouched: LOGIN_UNTOUCHED });
  if (environment.status === 'suspended' || environment.status === 'retired') {
    throw new AppError('FORBIDDEN', SERVER_DISABLED_MESSAGE, { reason: 'ENVIRONMENT_DISABLED', untouched: LOGIN_UNTOUCHED });
  }
  return environment;
}

/**
 * « Reconnecter » for OAuth servers (Figma): ephemeral web terminal running
 * `claude mcp login <name> --no-browser` (output never recorded, research §4.5) on the server of
 * the request's space, for its owner only ({@link requireMcpLoginServer}, checked before anything
 * is read or sent). Nuera Dev stores nothing: the grant stays in Claude Code. An id of another
 * space answers like an unknown one (NOT_FOUND).
 */
export async function startMcpLogin(
  ctx: Pick<RequestContext, 'user' | 'space' | 'environment'>,
  idOrName: string,
  options: { port?: McpRunnerPort } = {},
): Promise<{ terminal: TerminalDto; streamUrl: string }> {
  const environment = requireMcpLoginServer(ctx);
  const row = await getMcpServerRow({ spaceId: ctx.space.id, idOrName });
  if (!row) throw new AppError('NOT_FOUND', MCP_SERVER_NOT_FOUND);
  if (credentialSourceOf(row) !== 'claude_oauth') {
    throw new AppError('VALIDATION', 'Ce serveur ne se connecte pas par une autorisation OAuth.');
  }
  const port = options.port ?? runnerPortFor(environment.id);
  const sync = await syncMcpServersToCli({ spaceId: row.spaceId, upsert: [row] }, port);
  if (!sync.ok && sync.error) throw new AppError('RUNNER_UNAVAILABLE', sync.error);
  const terminal = await port.createLoginTerminal(row.name, ctx.user.id);
  await auditIn(ctx, {
    action: 'integration.mcp.login_started',
    summary: `connexion OAuth du serveur MCP « ${row.label} » ouverte dans un terminal`,
    targetType: 'mcp_server',
    targetId: row.id,
    environmentId: environment.id,
  });
  return { terminal, streamUrl: `/api/stream/terminals/${encodeURIComponent(terminal.id)}` };
}

/**
 * The CLI state (user-scope entries, OAuth grants) lives on the space's server: when the server of
 * a space is assigned, replaced or its token rotated, the CLI-diagnosed servers of the space go back
 * to « à tester » and are synced again at their next check.
 */
export async function resetCliMcpState(spaceId: string): Promise<number> {
  const rows = await db
    .update(mcpServers)
    .set({ status: 'unknown', syncedToCliAt: null, lastError: null })
    .where(and(eq(mcpServers.spaceId, spaceId), or(eq(mcpServers.transport, 'stdio'), eq(mcpServers.authKind, 'oauth'))))
    .returning({ id: mcpServers.id });
  return rows.length;
}
