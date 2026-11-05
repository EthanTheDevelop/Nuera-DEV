import 'server-only';
import type { McpCliStatus, TerminalDto } from '@nuera/shared/runner';
import { mcpServers } from '@nuera/db/schema';
import type { McpStatus } from '@nuera/db/schema';
import { eq, inArray } from 'drizzle-orm';
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
import { runner } from '@/server/runner/client';
import { audit } from '@/server/security/audit';
import { resolveDiagnosticHeaders } from './headers';
import { presetOf } from './presets';
import { probeMcpServer, probeOAuthEndpoint, type McpProbeResult } from './probe';
import {
  countActiveProjectsByServer,
  credentialSourceOf,
  getMcpServer,
  getMcpServerRow,
  readDiagnostic,
  type McpDiagnosticRecord,
  type McpServerRow,
  type McpServerView,
} from './registry';

/**
 * Non-mutating diagnostics of MCP servers (research §5.6):
 *  - HTTP servers with a Nuera credential (GitHub, Coolify, custom headers): `initialize` + `tools/list`
 *    with the same credential a session would get;
 *  - OAuth servers (Figma) and stdio servers (Playwright): `claude mcp get <name>` through the runner
 *    (Claude Code owns the OAuth grant; Nuera Dev never reads it), plus an unauthenticated
 *    reachability probe for OAuth endpoints.
 */

/** Runner calls used here (injectable in tests). */
export interface McpRunnerPort {
  mcpGet(name: string): Promise<McpCliStatus>;
  mcpSync(input: { upsert: Array<{ name: string; config: Record<string, unknown> }>; remove: string[] }): Promise<{
    results: Array<{ name: string; action: 'upsert' | 'remove'; ok: boolean; raw: string }>;
  }>;
  createLoginTerminal(serverName: string): Promise<TerminalDto>;
}

export const defaultRunnerPort: McpRunnerPort = {
  mcpGet: (name) => runner.claudeMcpGet({ params: { name } }),
  mcpSync: (input) => runner.claudeMcpSync({ body: input }),
  createLoginTerminal: (serverName) => runner.createTerminal({ body: { kind: 'mcp-login', serverName } }),
};

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

/** Writes/removes the user-scope entries of CLI-diagnosed servers (best effort, runner may be down). */
export async function syncMcpServersToCli(
  input: { upsert?: McpServerRow[]; remove?: string[] },
  port: McpRunnerPort = defaultRunnerPort,
): Promise<{ ok: boolean; results: Array<{ name: string; ok: boolean; raw: string }>; error: string | null }> {
  const upsert = (input.upsert ?? [])
    .filter(usesCliDiagnostics)
    .map((row) => ({ name: row.name, config: cliConfigOf(row) }))
    .filter((item): item is { name: string; config: Record<string, unknown> } => item.config !== null);
  const remove = input.remove ?? [];
  if (upsert.length === 0 && remove.length === 0) return { ok: true, results: [], error: null };
  try {
    const result = await port.mcpSync({ upsert, remove });
    const synced = result.results.filter((item) => item.ok && item.action === 'upsert').map((item) => item.name);
    if (synced.length) await db.update(mcpServers).set({ syncedToCliAt: new Date() }).where(inArray(mcpServers.name, synced));
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
  port?: McpRunnerPort;
  fetchImpl?: typeof fetch;
  actorUserId?: string | null;
}

export async function checkMcpServer(idOrName: string, options: CheckMcpOptions = {}): Promise<McpServerView> {
  const trigger = options.trigger ?? 'manual';
  const port = options.port ?? defaultRunnerPort;
  const row = await getMcpServerRow(idOrName);
  if (!row) throw new AppError('NOT_FOUND', 'Serveur MCP introuvable.');
  if (trigger === 'manual') {
    const map = (lastManualChecks.__nueraMcpLastManual ??= new Map());
    // A replaced secret or address resets the status to `unknown`: that test always runs.
    if (row.status !== 'unknown' && Date.now() - (map.get(row.id) ?? 0) < 10_000) return getMcpServer(row.id);
    map.set(row.id, Date.now());
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
  const coolify = preset?.id === 'coolify' ? await getStoredCoolify() : null;
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
        let cli = await port.mcpGet(row.name);
        if (cli.state === 'not_configured') {
          const sync = await syncMcpServersToCli({ upsert: [row] }, port);
          steps.push({ name: `claude mcp add-json --scope user ${row.name}`, ok: sync.ok, ms: timer(), ...(sync.error ? { providerMessage: sync.error } : {}) });
          if (sync.ok) cli = await port.mcpGet(row.name);
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
    const credential = await resolveDiagnosticHeaders(row.name);
    if (credential.missing) {
      next = 'needs_auth';
      reason = credential.missing;
      steps.push({ name: 'Identifiants', ok: false, ms: 0, providerMessage: credential.missing });
    } else {
      const probe = await probeMcpServer({
        url,
        headers: { ...(preset?.staticHeaders ?? {}), ...credential.headers },
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
        await updateCoolify((config) =>
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
    .where(eq(mcpServers.id, row.id));

  // Only servers used by at least one project raise notifications.
  const counts = await countActiveProjectsByServer();
  if ((counts.get(row.id) ?? 0) > 0 && row.isEnabled) {
    await applyHealthTransition({
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
    });
  }
  return getMcpServer(row.id);
}

/** Checks every server used by at least one project (scheduler, every 15 min). */
export async function checkActiveMcpServers(options: CheckMcpOptions = {}): Promise<Array<{ name: string; status: McpStatus | 'failed'; error?: string }>> {
  const counts = await countActiveProjectsByServer();
  const rows = await db.select().from(mcpServers);
  const active = rows.filter((row) => row.isEnabled && (counts.get(row.id) ?? 0) > 0);
  const results = await Promise.allSettled(active.map((row) => checkMcpServer(row.id, { ...options, trigger: options.trigger ?? 'schedule' })));
  return results.map((result, index) =>
    result.status === 'fulfilled'
      ? { name: active[index]!.name, status: result.value.status }
      : { name: active[index]!.name, status: 'failed' as const, error: result.reason instanceof Error ? result.reason.message : 'erreur' },
  );
}

/**
 * « Reconnecter » for OAuth servers (Figma): ephemeral web terminal running
 * `claude mcp login <name> --no-browser` (output never recorded, research §4.5). Nuera Dev stores
 * nothing: the grant stays in Claude Code.
 */
export async function startMcpLogin(
  idOrName: string,
  options: { actorUserId?: string | null; port?: McpRunnerPort } = {},
): Promise<{ terminal: TerminalDto; streamUrl: string }> {
  const port = options.port ?? defaultRunnerPort;
  const row = await getMcpServerRow(idOrName);
  if (!row) throw new AppError('NOT_FOUND', 'Serveur MCP introuvable.');
  if (credentialSourceOf(row) !== 'claude_oauth') {
    throw new AppError('VALIDATION', 'Ce serveur ne se connecte pas par une autorisation OAuth.');
  }
  const sync = await syncMcpServersToCli({ upsert: [row] }, port);
  if (!sync.ok && sync.error) throw new AppError('RUNNER_UNAVAILABLE', sync.error);
  const terminal = await port.createLoginTerminal(row.name);
  await audit({
    action: 'integration.mcp.login_started',
    summary: `connexion OAuth du serveur MCP « ${row.label} » ouverte dans un terminal`,
    targetType: 'mcp_server',
    targetId: row.id,
    actorUserId: options.actorUserId ?? null,
  });
  return { terminal, streamUrl: `/api/stream/terminals/${encodeURIComponent(terminal.id)}` };
}
