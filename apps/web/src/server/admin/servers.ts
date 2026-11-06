import 'server-only';
import { randomUUID } from 'node:crypto';
import { environmentSpaces, environments, invitations, projects, sessions, spaces, user } from '@nuera/db/schema';
import type { EnvironmentConfigSource, EnvironmentStatus, SessionBackend } from '@nuera/db/schema';
import {
  HealthResponseSchema,
  RUNNER_CONTRACT_VERSION,
  SHARED_SERVER_CONTRACT_VERSION,
  type HealthResponse,
} from '@nuera/shared/runner';
import { generateRunnerToken, hashToken } from '@nuera/shared/tokens';
import { and, asc, count, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import {
  decryptRunnerToken,
  encryptRunnerToken,
  getRunnerConfig,
  invalidateRunnerEndpoint,
} from '@/server/runner/config';
import { resetCliMcpState } from '@/server/mcp/diagnostics';
import { createNotification, spaceRecipients } from '@/server/notifications';
import { getRunnerForEnvironment, invalidateRunnerContract } from '@/server/runner/client';
import { runnerUnavailableMessage } from '@/server/runner/errors';
import { audit } from '@/server/security/audit';
import { invalidateSsrfCache } from '@/server/security/ssrf';
import { invalidateSettingsCache, updateEnvironmentIdentity } from '@/server/settings';
import { invalidateContextCache } from '@/server/tenancy/context';
import {
  assertAdmin,
  assertAdminMutation,
  iso,
  NOT_FOUND_ACCOUNT,
  NOT_FOUND_SERVER,
  UUID_PATTERN,
  verifyOwnPassword,
  type AdminActor,
} from './common';
import { assessRestrictedAccess } from './db-access';
import {
  closeRunnerRoleConnections,
  createRunnerRole,
  disableRunnerRoleLogin,
  refusedConnectionsNote,
  generateRunnerRoleName,
  generateRunnerRolePassword,
  resetRunnerRolePassword,
  roleRefusal,
  runnerDatabaseUrl,
} from './db-roles';
import { promoteRunnerToken } from './token-rotation';

/**
 * Administration › Serveurs (docs/MULTICOMPTE.md §4, §11). A « serveur » is one runner instance:
 *
 * - register: name + internal URL (http(s), no credentials; host in NUERA_RUNNER_HOSTS when set) →
 *   `pending` row, token `nrt_…` and a restricted PostgreSQL login role (`nuera_env_<8 hex>` in
 *   `nuera_runner`) — token and DSN are shown ONCE;
 * - « Vérifier »: GET /v1/health with the server's token (same server id, state `ready`, contract);
 * - assign to an account's space (only a `pending` server: a server already used is never reassigned);
 * - rotate the token (`next_token_*`, promoted after the first successful call), rename, location,
 *   ceiling of parallel sessions; retire (refused while active projects live on it; the open
 *   connections of its database role are closed);
 * - new internal address of a server in use: the server's tokens are replaced by a new one (shown
 *   once), so that the token its runner holds is never sent to another host; for the server of
 *   another account, only the owner of the instance may do it, with their password, and the account
 *   is notified (its personal journal shows the change). Two live servers never share an address;
 * - restrict the database access of the default server (role + DSN for RUNNER_DATABASE_URL): until
 *   its heartbeat reports `capabilities.database.restricted` AND PostgreSQL confirms it
 *   (db-access.ts), the console warns « Le serveur VPS-3 accède encore à toute la base de données. ».
 * Never the identity of a Claude account: only whether the CLI is installed.
 */

const LIVE_SESSION_STATUSES = ['running', 'waiting_permission', 'waiting_input'] as const;
const VERIFY_TIMEOUT_MS = 10_000;

export function fullDatabaseWarning(name: string): string {
  return `Le serveur ${name} accède encore à toute la base de données.`;
}

export interface AdminServerView {
  id: string;
  name: string;
  location: string | null;
  /** Internal URL of the runner (null for the default server: RUNNER_URL). */
  url: string | null;
  configSource: EnvironmentConfigSource;
  isDefault: boolean;
  status: EnvironmentStatus;
  /** First account of the server (`environments.space_id`). */
  account: { id: string; name: string; email: string } | null;
  /**
   * Every account the server works for (lot P1, shared servers), the first one first: each keeps its
   * space and its own Claude Code connection. Never what is inside their spaces (projects counted only).
   */
  accounts: ServerAccountView[];
  /** Attributed to the space of another account than the administrator viewing it. */
  ownedByOther: boolean;
  lastSeenAt: string | null;
  runnerVersion: string | null;
  contractVersion: number | null;
  backend: SessionBackend | null;
  /** Whether Claude Code is installed on the server (never the account it is signed in with). */
  claudeInstalled: boolean | null;
  /** The runner connects with its restricted role (heartbeat, confirmed by PostgreSQL). */
  databaseRestricted: boolean;
  hasDatabaseRole: boolean;
  /** « Le serveur VPS-3 accède encore à toute la base de données. » for the default server, else null. */
  warning: string | null;
  rotationPending: boolean;
  maxConcurrentSessions: number;
  maxConcurrentSessionsCap: number;
  sessionMemoryLimitMb: number | null;
  liveSessions: number;
  activeProjects: number;
  createdAt: string;
}

export interface ServerAccountView {
  id: string;
  name: string;
  email: string;
  spaceId: string;
  /** The server's first account: it sets the server's limits and cannot leave it (retire the server). */
  primary: boolean;
  disabled: boolean;
  /** Projects of this account on the server (archived ones included: they keep it attached). */
  projects: number;
}

type ServerRow = typeof environments.$inferSelect;

/** Accounts of each server (first account first), with their project count on that server. */
async function accountsOf(ids: string[]): Promise<Map<string, ServerAccountView[]>> {
  const result = new Map<string, ServerAccountView[]>();
  if (ids.length === 0) return result;
  const rows = await db
    .select({
      environmentId: environmentSpaces.environmentId,
      spaceId: environmentSpaces.spaceId,
      primarySpaceId: environments.spaceId,
      userId: user.id,
      name: user.name,
      email: user.email,
      disabledAt: user.disabledAt,
      projects: sql<number>`(select count(*)::int from ${projects} as p where p.environment_id = ${environmentSpaces}.${sql.identifier('environment_id')} and p.space_id = ${environmentSpaces}.${sql.identifier('space_id')})`,
    })
    .from(environmentSpaces)
    .innerJoin(environments, eq(environments.id, environmentSpaces.environmentId))
    .innerJoin(spaces, eq(spaces.id, environmentSpaces.spaceId))
    .innerJoin(user, and(eq(user.id, spaces.ownerUserId), isNull(user.deletedAt)))
    .where(inArray(environmentSpaces.environmentId, ids))
    .orderBy(asc(environmentSpaces.createdAt));
  for (const row of rows) {
    const list = result.get(row.environmentId) ?? [];
    list.push({
      id: row.userId,
      name: row.name,
      email: row.email,
      spaceId: row.spaceId,
      primary: row.primarySpaceId === row.spaceId,
      disabled: row.disabledAt !== null,
      projects: Number(row.projects ?? 0),
    });
    result.set(row.environmentId, list);
  }
  for (const list of result.values()) list.sort((a, b) => Number(b.primary) - Number(a.primary));
  return result;
}

/** Users of every account a server works for (their contexts are invalidated after a change). */
async function linkedUserIds(environmentId: string): Promise<string[]> {
  const rows = await db
    .select({ id: spaces.ownerUserId })
    .from(environmentSpaces)
    .innerJoin(spaces, eq(spaces.id, environmentSpaces.spaceId))
    .where(eq(environmentSpaces.environmentId, environmentId));
  return rows.map((row) => row.id).filter((id): id is string => Boolean(id));
}

function claudeInstalledOf(row: Pick<ServerRow, 'capabilities'>): boolean | null {
  const capabilities = (row.capabilities ?? {}) as { claudeVersion?: string | null };
  return 'claudeVersion' in capabilities ? Boolean(capabilities.claudeVersion) : null;
}

/** Every server, the default one first, retired ones last. */
export async function listServers(actor: AdminActor): Promise<AdminServerView[]> {
  assertAdmin(actor);
  const rows = await db
    .select({
      server: environments,
      ownerId: spaces.ownerUserId,
      accountId: user.id,
      accountName: user.name,
      accountEmail: user.email,
    })
    .from(environments)
    .leftJoin(spaces, eq(spaces.id, environments.spaceId))
    .leftJoin(user, and(eq(user.id, spaces.ownerUserId), isNull(user.deletedAt)))
    .orderBy(
      sql`case when ${environments.status} = 'retired' then 1 else 0 end`,
      sql`case when ${environments.isDefault} then 0 else 1 end`,
      asc(environments.createdAt),
    );
  const ids = rows.map((row) => row.server.id);
  if (ids.length === 0) return [];
  const [live, active, restricted, accounts] = await Promise.all([
    db
      .select({ id: sessions.environmentId, total: count() })
      .from(sessions)
      .where(
        and(
          inArray(sessions.environmentId, ids),
          inArray(sessions.status, [...LIVE_SESSION_STATUSES]),
        ),
      )
      .groupBy(sessions.environmentId),
    db
      .select({ id: projects.environmentId, total: count() })
      .from(projects)
      .where(and(inArray(projects.environmentId, ids), isNull(projects.archivedAt)))
      .groupBy(projects.environmentId),
    assessRestrictedAccess(
      rows.filter((row) => row.server.status !== 'retired').map((row) => row.server),
    ),
    accountsOf(ids),
  ]);
  const liveBy = new Map(live.map((row) => [row.id, Number(row.total)]));
  const activeBy = new Map(active.map((row) => [row.id, Number(row.total)]));
  return rows.map(({ server, accountId, accountName, accountEmail, ownerId }) => {
    const databaseRestricted = restricted.get(server.id) === true;
    return {
      id: server.id,
      name: server.name,
      location: server.location,
      url: server.configSource === 'env' ? null : server.url,
      configSource: server.configSource,
      isDefault: server.isDefault,
      status: server.status,
      account:
        accountId && accountName && accountEmail
          ? { id: accountId, name: accountName, email: accountEmail }
          : null,
      accounts: accounts.get(server.id) ?? [],
      ownedByOther: server.spaceId !== null && ownerId !== actor.id,
      lastSeenAt: iso(server.lastSeenAt),
      runnerVersion: server.runnerVersion,
      contractVersion: server.contractVersion,
      backend: server.backend,
      claudeInstalled: claudeInstalledOf(server),
      databaseRestricted,
      hasDatabaseRole: Boolean(server.dbRole),
      warning:
        server.isDefault && server.status !== 'retired' && !databaseRestricted
          ? fullDatabaseWarning(server.name)
          : null,
      rotationPending: Boolean(server.nextTokenHash),
      maxConcurrentSessions: server.maxConcurrentSessions,
      maxConcurrentSessionsCap: server.maxConcurrentSessionsCap,
      sessionMemoryLimitMb: server.sessionMemoryLimitMb,
      liveSessions: liveBy.get(server.id) ?? 0,
      activeProjects: activeBy.get(server.id) ?? 0,
      createdAt: server.createdAt.toISOString(),
    };
  });
}

export async function getServer(
  actor: AdminActor,
  environmentId: string,
): Promise<AdminServerView> {
  const found = UUID_PATTERN.test(environmentId)
    ? (await listServers(actor)).find((item) => item.id === environmentId)
    : undefined;
  if (!found) throw new AppError('NOT_FOUND', NOT_FOUND_SERVER);
  return found;
}

async function loadServer(environmentId: string): Promise<ServerRow> {
  if (!UUID_PATTERN.test(environmentId)) throw new AppError('NOT_FOUND', NOT_FOUND_SERVER);
  const [row] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', NOT_FOUND_SERVER);
  return row;
}

function invalidateServer(
  environmentId: string,
  userIds: Array<string | null | undefined> = [],
): void {
  invalidateRunnerEndpoint(environmentId);
  invalidateRunnerContract(environmentId);
  invalidateSettingsCache({ kind: 'environment', id: environmentId });
  for (const id of userIds) if (id) invalidateContextCache(id);
}

/**
 * The Claude Code state of the MCP servers (user-scope entries, OAuth grants) lives on the server of
 * a space: once that server is assigned, replaced, retired or its token rotated, the CLI-diagnosed
 * MCP servers of the space go back to « à tester » (docs/MULTICOMPTE.md §7). Best effort: the
 * administration action already happened.
 */
async function resetSpaceMcpState(spaceId: string | null | undefined): Promise<void> {
  if (!spaceId) return;
  try {
    await resetCliMcpState(spaceId);
  } catch (error) {
    console.warn(
      "[serveurs] état MCP de l'espace non réinitialisé",
      error instanceof Error ? error.message : error,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Adresse interne
// ---------------------------------------------------------------------------------------------

/** NUERA_RUNNER_HOSTS: comma-separated host names (or host:port) allowed for a runner URL; empty = any. */
export function allowedRunnerHosts(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return (env.NUERA_RUNNER_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/** Validates the internal URL of a runner; returns it normalised (no trailing slash). */
export function normaliseRunnerUrl(
  raw: string,
  env: Record<string, string | undefined> = process.env,
): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError('VALIDATION', 'Adresse interne invalide.', {
      detail: 'Exemple : http://runner-vps-4:4100',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('VALIDATION', 'Adresse interne invalide : http ou https attendu.');
  }
  if (url.username || url.password) {
    throw new AppError(
      'VALIDATION',
      "Adresse interne invalide : elle ne doit contenir ni identifiant ni mot de passe (le jeton du serveur s'en charge).",
    );
  }
  if (url.search || url.hash)
    throw new AppError('VALIDATION', 'Adresse interne invalide : ni paramètres ni ancre.');
  const allowed = allowedRunnerHosts(env);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (allowed.length > 0 && !allowed.includes(host) && !allowed.includes(url.host.toLowerCase())) {
    throw new AppError('VALIDATION', `Hôte non autorisé : ${host}.`, {
      detail: `Les serveurs doivent être joignables sur un hôte de NUERA_RUNNER_HOSTS (${allowed.join(', ')}).`,
    });
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Same normalisation as {@link normaliseRunnerUrl}, without the checks (RUNNER_URL, stored rows). */
function comparableRunnerUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * Two live servers never share an address: the web would send one server's token and its space's
 * calls to the runner of another. Retired servers do not count (a new server may take the address
 * of the one it replaces).
 */
async function assertAddressFree(url: string, exceptId: string | null): Promise<void> {
  const rows = await db
    .select({
      id: environments.id,
      name: environments.name,
      url: environments.url,
      configSource: environments.configSource,
    })
    .from(environments)
    .where(ne(environments.status, 'retired'));
  for (const row of rows) {
    if (row.id === exceptId) continue;
    const other = comparableRunnerUrl(
      row.configSource === 'env' ? getRunnerConfig().baseUrl : row.url,
    );
    if (other !== null && other === url) {
      throw new AppError('CONFLICT', `Cette adresse est déjà celle du serveur « ${row.name} ».`);
    }
  }
}

/** Owner of the space a server is attributed to (null: not attributed, or a space without owner). */
async function spaceOwnerOf(spaceId: string | null): Promise<string | null> {
  if (!spaceId) return null;
  const [space] = await db
    .select({ ownerUserId: spaces.ownerUserId })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  return space?.ownerUserId ?? null;
}

/**
 * Warns the members of the space of a server that an administrator changed it (never the
 * administrator acting on their own server). Best effort: the change already happened.
 */
async function notifyServerChange(
  row: Pick<ServerRow, 'id' | 'spaceId'>,
  actor: AdminActor,
  input: { title: string; body: string },
): Promise<void> {
  if (!row.spaceId) return;
  try {
    // Every account of a shared server (lot P1), each in its own space.
    const links = await db.select({ spaceId: environmentSpaces.spaceId }).from(environmentSpaces).where(eq(environmentSpaces.environmentId, row.id));
    const spaceIds = [...new Set([row.spaceId, ...links.map((link) => link.spaceId)])];
    for (const spaceId of spaceIds) {
      const recipients = (await spaceRecipients(spaceId)).filter((id) => id !== actor.id);
      if (recipients.length === 0) continue;
      await createNotification(
        {
          kind: 'security',
          severity: 'warning',
          title: input.title,
          body: input.body,
          href: '/parametres?onglet=compte-et-securite',
        },
        { spaceId, userIds: recipients, environmentId: row.id },
      );
    }
  } catch (error) {
    console.warn(
      '[serveurs] notification du compte impossible',
      error instanceof Error ? error.message : error,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Enregistrer
// ---------------------------------------------------------------------------------------------

export const registerServerSchema = z.object({
  name: z.string('nom requis').trim().min(1, 'nom requis').max(60, '60 caractères au maximum'),
  url: z.string('adresse interne requise').trim().min(1, 'adresse interne requise').max(500),
  location: z.string().trim().max(80, '80 caractères au maximum').nullish(),
});

export interface RegisteredServer {
  id: string;
  name: string;
  /** RUNNER_TOKEN of the new runner — shown once. */
  token: string;
  /** NUERA_ENVIRONMENT_ID of the new runner. */
  environmentId: string;
  /** Restricted login role and RUNNER_DATABASE_URL of the new runner — shown once. */
  dbRole: string;
  databaseUrl: string;
  server: AdminServerView;
}

/** Registers a server: `pending` row, token and restricted database role in one transaction. */
export async function registerServer(
  actor: AdminActor,
  rawInput: z.input<typeof registerServerSchema>,
): Promise<RegisteredServer> {
  assertAdminMutation(actor);
  const parsed = registerServerSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Vérifiez les champs signalés.', {
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join('.')} : ${issue.message}`)
        .join(' ; '),
    });
  }
  const url = normaliseRunnerUrl(parsed.data.url);
  await assertAddressFree(url, null);
  const id = randomUUID();
  const token = generateRunnerToken();
  const role = generateRunnerRoleName();
  const password = generateRunnerRolePassword();
  const databaseUrl = runnerDatabaseUrl(role, password);
  try {
    await db.transaction(async (tx) => {
      await tx.insert(environments).values({
        id,
        name: parsed.data.name,
        location: parsed.data.location || null,
        status: 'pending',
        configSource: 'db',
        isDefault: false,
        url,
        tokenEncrypted: encryptRunnerToken(id, token),
        tokenHash: hashToken(token),
        dbRole: role,
        createdByUserId: actor.id,
      });
      try {
        await createRunnerRole(tx, role, password);
      } catch (error) {
        throw roleRefusal(error);
      }
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw roleRefusal(error);
  }
  // A new internal host: outgoing requests chosen by users (MCP, Coolify) must never reach it.
  invalidateSsrfCache();
  await audit({
    action: 'admin.server_registered',
    summary: `serveur « ${parsed.data.name} » enregistré (${url}) · accès base restreint ${role}`,
    actorUserId: actor.id,
    targetType: 'environment',
    targetId: id,
    environmentId: id,
    metadata: { url, dbRole: role },
  });
  return {
    id,
    name: parsed.data.name,
    token,
    environmentId: id,
    dbRole: role,
    databaseUrl,
    server: await getServer(actor, id),
  };
}

// ---------------------------------------------------------------------------------------------
// Vérifier
// ---------------------------------------------------------------------------------------------

type Probe =
  | { kind: 'ok'; health: HealthResponse }
  | { kind: 'unauthorized' }
  | { kind: 'unreachable'; detail: string }
  | { kind: 'invalid'; detail: string };

async function probeHealth(baseUrl: string, token: string): Promise<Probe> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/health`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch (error) {
    return {
      kind: 'unreachable',
      detail: error instanceof Error ? error.message.slice(0, 200) : 'connexion impossible',
    };
  }
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'unauthorized' };
  }
  const text = await response.text().catch(() => '');
  if (!response.ok)
    return response.status >= 500
      ? { kind: 'unreachable', detail: `HTTP ${response.status}` }
      : { kind: 'invalid', detail: `HTTP ${response.status}` };
  try {
    const parsed = HealthResponseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { kind: 'invalid', detail: 'réponse non conforme au contrat' };
    return { kind: 'ok', health: parsed.data };
  } catch {
    return { kind: 'invalid', detail: 'réponse illisible' };
  }
}

export interface ServerVerification {
  ok: boolean;
  /** French verdict shown in the console. */
  message: string;
  problems: string[];
  version: string | null;
  state: string | null;
  contractVersion: number | null;
  /** The rotated token answered and became the current one. */
  tokenPromoted: boolean;
}

/** « Vérifier »: GET /v1/health of the server with its own token. */
export async function verifyServer(
  actor: AdminActor,
  environmentId: string,
): Promise<ServerVerification> {
  assertAdminMutation(actor);
  const row = await loadServer(environmentId);
  let baseUrl: string | null;
  const tokens: Array<{ token: string; next: boolean }> = [];
  if (row.configSource === 'env') {
    const config = getRunnerConfig();
    baseUrl = config.baseUrl;
    if (config.token) tokens.push({ token: config.token, next: false });
  } else {
    baseUrl = row.url;
    for (const [cipher, next] of [
      [row.tokenEncrypted, false],
      [row.nextTokenEncrypted, true],
    ] as const) {
      if (!cipher) continue;
      try {
        tokens.push({ token: decryptRunnerToken(row.id, cipher), next });
      } catch {
        // Unreadable ciphertext: reported below when no token is usable.
      }
    }
  }
  const empty = { version: null, state: null, contractVersion: null, tokenPromoted: false };
  if (!baseUrl)
    return {
      ok: false,
      message: `L'adresse du serveur ${row.name} n'est pas configurée.`,
      problems: [],
      ...empty,
    };
  if (tokens.length === 0) {
    return {
      ok: false,
      message: `Le jeton du serveur ${row.name} est illisible : renouvelez-le.`,
      problems: [],
      ...empty,
    };
  }

  let probe: Probe = { kind: 'unauthorized' };
  let usedNext = false;
  for (const candidate of tokens) {
    probe = await probeHealth(baseUrl, candidate.token);
    usedNext = candidate.next;
    if (probe.kind !== 'unauthorized') break;
  }
  let promoted = false;
  if (probe.kind === 'ok' && usedNext) {
    const next = tokens.find((item) => item.next);
    if (next) promoted = await promoteRunnerToken(row.id, hashToken(next.token));
  }

  let result: ServerVerification;
  if (probe.kind === 'unreachable') {
    result = {
      ok: false,
      message: runnerUnavailableMessage(row.name),
      problems: [probe.detail],
      ...empty,
    };
  } else if (probe.kind === 'unauthorized') {
    result = {
      ok: false,
      message: `${row.name} refuse le jeton de Nuera Dev : vérifiez RUNNER_TOKEN dans les variables de ce runner.`,
      problems: [],
      ...empty,
    };
  } else if (probe.kind === 'invalid') {
    result = {
      ok: false,
      message: `${row.name} a répondu, mais pas comme un runner de Nuera Dev.`,
      problems: [probe.detail],
      ...empty,
    };
  } else {
    const health = probe.health;
    const problems: string[] = [];
    const state = health.state ?? 'ready';
    const contract = health.contractVersion ?? 1;
    if (!health.environment || health.environment.id !== row.id) {
      problems.push(
        health.environment
          ? `Ce runner sert un autre serveur (${health.environment.name}) : vérifiez son RUNNER_TOKEN et son NUERA_ENVIRONMENT_ID.`
          : "Ce runner n'a pas reconnu son serveur : vérifiez son RUNNER_TOKEN.",
      );
    }
    if (state !== 'ready' && !(state === 'disabled' && row.status === 'suspended')) {
      problems.push(
        state === 'starting'
          ? 'Le runner termine son démarrage : réessayez dans un instant.'
          : `État du runner : ${state}.`,
      );
    }
    if (contract !== RUNNER_CONTRACT_VERSION) {
      problems.push(
        `Contrat du runner ${contract}, attendu ${RUNNER_CONTRACT_VERSION} : mettez ce runner à jour.`,
      );
    }
    if (!health.database.ok)
      problems.push(
        `Base de données injoignable depuis le runner${health.database.error ? ` : ${health.database.error}` : ''}.`,
      );
    result = {
      ok: problems.length === 0,
      message:
        problems.length === 0
          ? `${row.name} répond · runner ${health.version}`
          : `${row.name} répond, mais n'est pas prêt.`,
      problems,
      version: health.version,
      state,
      contractVersion: contract,
      tokenPromoted: promoted,
    };
    invalidateRunnerContract(row.id);
  }
  await audit({
    action: 'admin.server_verified',
    summary: `vérification du serveur « ${row.name} » : ${result.ok ? 'prêt' : result.message}`,
    actorUserId: actor.id,
    targetType: 'environment',
    targetId: row.id,
    environmentId: row.id,
    metadata: { ok: result.ok, state: result.state, contractVersion: result.contractVersion },
  });
  return result;
}

// ---------------------------------------------------------------------------------------------
// Attribuer
// ---------------------------------------------------------------------------------------------

export const assignServerSchema = z.object({
  userId: z.string('compte requis').trim().min(1, 'compte requis').max(200),
});

/** Attaches a `pending` server to the personal space of an account (its server from now on). */
export async function assignServer(
  actor: AdminActor,
  environmentId: string,
  input: { userId: string },
): Promise<AdminServerView> {
  assertAdminMutation(actor);
  const { userId } = assignServerSchema.parse(input);
  if (!UUID_PATTERN.test(environmentId)) throw new AppError('NOT_FOUND', NOT_FOUND_SERVER);
  const outcome = await db.transaction(async (tx) => {
    const [server] = await tx
      .select()
      .from(environments)
      .where(eq(environments.id, environmentId))
      .for('update');
    if (!server) throw new AppError('NOT_FOUND', NOT_FOUND_SERVER);
    if (server.status !== 'pending' || server.spaceId) {
      throw new AppError(
        'CONFLICT',
        'Seul un serveur jamais utilisé peut être attribué : retirez celui-ci et enregistrez-en un nouveau.',
      );
    }
    // A server promised to an invitation in progress goes to the person invited (never taken from them silently).
    const [promised] = await tx
      .select({ email: invitations.email })
      .from(invitations)
      .where(
        and(
          eq(invitations.environmentId, server.id),
          eq(invitations.kind, 'invite'),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (promised) {
      throw new AppError(
        'CONFLICT',
        `Ce serveur est promis à l'invitation adressée à ${promised.email} : annulez-la d'abord.`,
      );
    }
    const [target] = await tx
      .select({ id: user.id, email: user.email, disabledAt: user.disabledAt, spaceId: spaces.id })
      .from(user)
      .leftJoin(
        spaces,
        and(
          eq(spaces.ownerUserId, user.id),
          eq(spaces.kind, 'personal'),
          isNull(spaces.archivedAt),
        ),
      )
      .where(and(eq(user.id, userId), isNull(user.deletedAt)))
      .limit(1);
    if (!target) throw new AppError('NOT_FOUND', NOT_FOUND_ACCOUNT);
    if (!target.spaceId)
      throw new AppError(
        'CONFLICT',
        "Ce compte n'a pas encore d'espace : il doit d'abord se connecter une fois.",
      );
    // Its first account or not (lot P1): a space works on one server at a time.
    await tx.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, target.spaceId)).for('update');
    const [current] = await tx
      .select({ id: environments.id, name: environments.name })
      .from(environmentSpaces)
      .innerJoin(environments, eq(environments.id, environmentSpaces.environmentId))
      .where(and(eq(environmentSpaces.spaceId, target.spaceId), ne(environments.status, 'retired')))
      .limit(1);
    if (current)
      throw new AppError(
        'CONFLICT',
        `Ce compte a déjà un serveur (${current.name}) : retirez-le d'abord.`,
      );
    await tx
      .update(environments)
      .set({ spaceId: target.spaceId, status: target.disabledAt ? 'suspended' : 'active' })
      .where(eq(environments.id, server.id));
    return { server, target };
  });
  invalidateServer(environmentId, [outcome.target.id]);
  await resetSpaceMcpState(outcome.target.spaceId);
  await audit({
    action: 'admin.server_assigned',
    summary: `serveur « ${outcome.server.name} » attribué à ${outcome.target.email}`,
    actorUserId: actor.id,
    subjectUserId: outcome.target.id,
    targetType: 'environment',
    targetId: environmentId,
    environmentId,
  });
  return getServer(actor, environmentId);
}

// ---------------------------------------------------------------------------------------------
// Serveur partagé (lot P1) : d'autres comptes sur un serveur en service
// ---------------------------------------------------------------------------------------------

/** « VPS-3 ne peut pas encore accueillir un autre compte… » (runner older than contract 3). */
export function sharedServerOutdatedMessage(name: string): string {
  return `Le runner du serveur ${name} doit être mis à jour avant d'accueillir un autre compte : chacun doit y avoir sa propre connexion Claude Code.`;
}

/** Best effort after a change of the accounts of a server: tell its runner (folders, common configuration). */
function announceAccounts(environmentId: string, spaceId: string | null): void {
  if (process.env.NUERA_CLAUDE_CONFIG_PUSH === 'off') return;
  void getRunnerForEnvironment(environmentId)
    .claudeConfigSync({ body: { reason: 'changed', ...(spaceId ? { spaceId } : {}) } }, { timeoutMs: 45_000 })
    .catch(() => undefined);
}

async function notifyAccounts(environmentId: string, spaceIds: string[], actor: AdminActor, input: { title: string; body: string }): Promise<void> {
  try {
    for (const spaceId of spaceIds) {
      const recipients = (await spaceRecipients(spaceId)).filter((id) => id !== actor.id);
      if (recipients.length === 0) continue;
      await createNotification(
        { kind: 'server', severity: 'info', title: input.title, body: input.body, href: '/parametres?onglet=serveur' },
        { spaceId, userIds: recipients, environmentId },
      );
    }
  } catch (error) {
    console.warn('[serveurs] notification des comptes impossible', error instanceof Error ? error.message : error);
  }
}

/**
 * Adds an account to a server in service (lot P1). The account keeps its own space, projects and
 * sessions (never visible to the others) and gets its OWN Claude Code connection on that server
 * (a separate CLI config folder kept by the runner: it connects with « Se reconnecter dans un
 * terminal », nobody else's login is ever used). « Sessions parallèles » of the server is shared.
 * Refused: a server not yet attributed (use {@link assignServer}), suspended or retired, a runner
 * older than contract 3, an account that already has a server.
 */
export async function addServerAccount(
  actor: AdminActor,
  environmentId: string,
  input: { userId: string },
): Promise<AdminServerView> {
  assertAdminMutation(actor);
  const { userId } = assignServerSchema.parse(input);
  if (!UUID_PATTERN.test(environmentId)) throw new AppError('NOT_FOUND', NOT_FOUND_SERVER);
  const outcome = await db.transaction(async (tx) => {
    const [server] = await tx.select().from(environments).where(eq(environments.id, environmentId)).for('update');
    if (!server) throw new AppError('NOT_FOUND', NOT_FOUND_SERVER);
    if (server.status === 'retired') throw new AppError('CONFLICT', 'Ce serveur est retiré.');
    if (!server.spaceId || server.status === 'pending') {
      throw new AppError('CONFLICT', "Ce serveur n'est encore attribué à personne : attribuez-le d'abord à un compte.");
    }
    if (server.status === 'suspended') {
      throw new AppError('CONFLICT', "Ce serveur est suspendu (son premier compte est désactivé) : réactivez ce compte avant d'en ajouter un autre.");
    }
    if ((server.contractVersion ?? 1) < SHARED_SERVER_CONTRACT_VERSION) {
      throw new AppError('CONFLICT', sharedServerOutdatedMessage(server.name), { reason: 'RUNNER_OUTDATED' });
    }
    const [target] = await tx
      .select({ id: user.id, email: user.email, name: user.name, disabledAt: user.disabledAt, spaceId: spaces.id })
      .from(user)
      .leftJoin(spaces, and(eq(spaces.ownerUserId, user.id), eq(spaces.kind, 'personal'), isNull(spaces.archivedAt)))
      .where(and(eq(user.id, userId), isNull(user.deletedAt)))
      .limit(1);
    if (!target) throw new AppError('NOT_FOUND', NOT_FOUND_ACCOUNT);
    if (!target.spaceId) throw new AppError('CONFLICT', "Ce compte n'a pas encore d'espace : il doit d'abord se connecter une fois.");
    if (target.disabledAt) throw new AppError('CONFLICT', "Ce compte est désactivé : réactivez-le avant de l'ajouter à un serveur.");
    // One server in use per space: the space row is locked so that two additions never both pass.
    await tx.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, target.spaceId)).for('update');
    const [current] = await tx
      .select({ id: environments.id, name: environments.name })
      .from(environmentSpaces)
      .innerJoin(environments, eq(environments.id, environmentSpaces.environmentId))
      .where(and(eq(environmentSpaces.spaceId, target.spaceId), ne(environments.status, 'retired')))
      .limit(1);
    if (current?.id === server.id) throw new AppError('CONFLICT', 'Ce compte travaille déjà sur ce serveur.');
    if (current) throw new AppError('CONFLICT', `Ce compte a déjà un serveur (${current.name}) : retirez-le d'abord.`);
    await tx.insert(environmentSpaces).values({ environmentId: server.id, spaceId: target.spaceId, createdByUserId: actor.id });
    return { server, target: { ...target, spaceId: target.spaceId } };
  });
  invalidateServer(environmentId, [outcome.target.id, ...(await linkedUserIds(environmentId))]);
  await resetSpaceMcpState(outcome.target.spaceId);
  announceAccounts(environmentId, outcome.target.spaceId);
  await audit({
    action: 'admin.server_account_added',
    summary: `compte ${outcome.target.email} ajouté au serveur « ${outcome.server.name} » (serveur partagé, connexion Claude Code propre au compte)`,
    actorUserId: actor.id,
    subjectUserId: outcome.target.id,
    targetType: 'environment',
    targetId: environmentId,
    environmentId,
    metadata: { spaceId: outcome.target.spaceId },
  });
  await notifyAccounts(environmentId, [outcome.target.spaceId], actor, {
    title: `Vous travaillez désormais sur le serveur ${outcome.server.name}.`,
    body: 'Connectez votre propre compte Claude Code depuis Paramètres › Claude Code : vos projets et sessions restent les vôtres.',
  });
  await notifyAccounts(environmentId, [outcome.server.spaceId!], actor, {
    title: `Le serveur ${outcome.server.name} accueille aussi un autre compte.`,
    body: "Chaque compte garde son espace et sa propre connexion Claude Code ; les sessions parallèles du serveur sont partagées.",
  });
  return getServer(actor, environmentId);
}

/**
 * Removes an account from a shared server (lot P1). Refused for the server's first account (retire the
 * server instead) and while the account still has projects there (archived ones too: delete them).
 * Its Claude Code config folder on the runner is signed out and removed (best effort, journalled).
 */
export async function removeServerAccount(
  actor: AdminActor,
  environmentId: string,
  userId: string,
): Promise<AdminServerView> {
  assertAdminMutation(actor);
  if (!UUID_PATTERN.test(environmentId) || !userId || userId.length > 200) throw new AppError('NOT_FOUND', NOT_FOUND_SERVER);
  const outcome = await db.transaction(async (tx) => {
    const [server] = await tx.select().from(environments).where(eq(environments.id, environmentId)).for('update');
    if (!server) throw new AppError('NOT_FOUND', NOT_FOUND_SERVER);
    const [target] = await tx
      .select({ id: user.id, email: user.email, spaceId: environmentSpaces.spaceId })
      .from(environmentSpaces)
      .innerJoin(spaces, eq(spaces.id, environmentSpaces.spaceId))
      .innerJoin(user, eq(user.id, spaces.ownerUserId))
      .where(and(eq(environmentSpaces.environmentId, server.id), eq(user.id, userId)))
      .limit(1);
    if (!target) throw new AppError('NOT_FOUND', NOT_FOUND_ACCOUNT);
    if (server.spaceId === target.spaceId) {
      throw new AppError('CONFLICT', "C'est le premier compte de ce serveur : retirez le serveur pour le libérer.");
    }
    const [held] = await tx
      .select({ total: count() })
      .from(projects)
      .where(and(eq(projects.environmentId, server.id), eq(projects.spaceId, target.spaceId)));
    const total = Number(held?.total ?? 0);
    if (total > 0) {
      throw new AppError(
        'CONFLICT',
        `Ce compte a encore ${total === 1 ? 'un projet' : `${total} projets`} sur ce serveur (archivés compris) : ${total === 1 ? "qu'il le supprime" : "qu'il les supprime"} d'abord.`,
      );
    }
    await tx.delete(environmentSpaces).where(and(eq(environmentSpaces.environmentId, server.id), eq(environmentSpaces.spaceId, target.spaceId)));
    return { server, target };
  });
  invalidateServer(environmentId, [outcome.target.id, ...(await linkedUserIds(environmentId))]);
  await resetSpaceMcpState(outcome.target.spaceId);
  // Its Claude login must not stay on a server it no longer works on.
  let forgotten: { removed: boolean; signedOut: boolean } | null = null;
  try {
    forgotten = await getRunnerForEnvironment(environmentId).claudeAccountForget({ params: { spaceId: outcome.target.spaceId } }, { timeoutMs: 45_000 });
  } catch (error) {
    console.warn('[serveurs] dossier Claude du compte non supprimé', error instanceof Error ? error.message : error);
  }
  await audit({
    action: 'admin.server_account_removed',
    summary: `compte ${outcome.target.email} retiré du serveur « ${outcome.server.name} »${forgotten?.removed ? ' · connexion Claude Code du compte supprimée du serveur' : ' · runner injoignable : la connexion Claude Code du compte sera supprimée à son prochain démarrage'}`,
    actorUserId: actor.id,
    subjectUserId: outcome.target.id,
    targetType: 'environment',
    targetId: environmentId,
    environmentId,
    metadata: { spaceId: outcome.target.spaceId, claudeFolderRemoved: forgotten?.removed ?? false, signedOut: forgotten?.signedOut ?? false },
  });
  await notifyAccounts(environmentId, [outcome.target.spaceId], actor, {
    title: `Vous ne travaillez plus sur le serveur ${outcome.server.name}.`,
    body: 'Un administrateur doit vous attribuer un autre serveur ; votre connexion Claude Code a été retirée de celui-ci.',
  });
  return getServer(actor, environmentId);
}

// ---------------------------------------------------------------------------------------------
// Renouveler le jeton
// ---------------------------------------------------------------------------------------------

export interface RotatedToken {
  id: string;
  /** New RUNNER_TOKEN — shown once. Both tokens work until the runner uses the new one. */
  token: string;
  server: AdminServerView;
}

export async function rotateServerToken(
  actor: AdminActor,
  environmentId: string,
): Promise<RotatedToken> {
  assertAdminMutation(actor);
  const row = await loadServer(environmentId);
  if (row.configSource === 'env') {
    throw new AppError(
      'CONFLICT',
      'Le jeton de ce serveur est RUNNER_TOKEN : changez-le dans les variables du service web et du runner.',
    );
  }
  if (row.status === 'retired') throw new AppError('CONFLICT', 'Ce serveur est retiré.');
  const token = generateRunnerToken();
  await db
    .update(environments)
    .set({ nextTokenEncrypted: encryptRunnerToken(row.id, token), nextTokenHash: hashToken(token) })
    .where(eq(environments.id, row.id));
  invalidateServer(row.id);
  await resetSpaceMcpState(row.spaceId);
  const ownerId = await spaceOwnerOf(row.spaceId);
  await audit({
    action: 'admin.server_token_rotated',
    summary: `nouveau jeton créé pour le serveur « ${row.name} » : l'ancien reste accepté jusqu'au premier appel avec le nouveau`,
    actorUserId: actor.id,
    subjectUserId: ownerId,
    targetType: 'environment',
    targetId: row.id,
    environmentId: row.id,
  });
  await notifyServerChange(row, actor, {
    title: `Un administrateur a renouvelé le jeton de votre serveur ${row.name}.`,
    body: "Le runner de ce serveur doit être redéployé avec le nouveau jeton. Si vous n'êtes pas au courant, prévenez un administrateur.",
  });
  return { id: row.id, token, server: await getServer(actor, row.id) };
}

// ---------------------------------------------------------------------------------------------
// Modifier
// ---------------------------------------------------------------------------------------------

export const updateServerSchema = z
  .object({
    name: z.string().trim().min(1, 'nom requis').max(60, '60 caractères au maximum').optional(),
    location: z.string().trim().max(80, '80 caractères au maximum').nullable().optional(),
    url: z.string().trim().min(1).max(500).optional(),
    maxConcurrentSessionsCap: z
      .number()
      .int()
      .min(1, '1 au minimum')
      .max(64, '64 au maximum')
      .optional(),
    /** The administrator's own password: required for a new address of another account's server. */
    password: z.string().min(1, 'mot de passe requis').max(256).optional(),
  })
  .refine(
    (value) =>
      Object.entries(value).some(([key, item]) => key !== 'password' && item !== undefined),
    'aucune modification',
  );

export const SERVER_ADDRESS_GUARDS = {
  ownerOnly:
    "Seul le propriétaire de l'instance peut changer l'adresse du serveur d'un autre compte.",
  password:
    "Confirmez avec votre mot de passe pour changer l'adresse du serveur d'un autre compte.",
} as const;

export interface UpdatedServer {
  server: AdminServerView;
  /**
   * New RUNNER_TOKEN when the address of a server in use changed (shown once): its previous tokens
   * are refused from now on and never sent to the new address. Null otherwise.
   */
  token: string | null;
}

/**
 * Name, location, internal address and ceiling of parallel sessions of a server.
 *
 * A new address of a server in use (attributed, or no longer `pending`) replaces its tokens: the
 * token its runner holds is never sent to another host, and only whoever configures the runner
 * with the new token (shown once) gets the server working again. For the server of another
 * account, only the owner of the instance may change the address, with their password; the
 * account is notified and the journal entry names it (personal journal).
 */
export async function updateServer(
  actor: AdminActor,
  environmentId: string,
  rawInput: z.input<typeof updateServerSchema>,
): Promise<UpdatedServer> {
  assertAdminMutation(actor);
  const parsed = updateServerSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Vérifiez les champs signalés.', {
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'serveur'} : ${issue.message}`)
        .join(' ; '),
    });
  }
  const row = await loadServer(environmentId);
  const input = parsed.data;

  // Every check of a new address runs before anything is written.
  let nextUrl: string | null = null;
  let ownerId: string | null = null;
  let foreign = false;
  if (input.url !== undefined) {
    if (row.configSource === 'env')
      throw new AppError(
        'CONFLICT',
        "L'adresse de ce serveur est RUNNER_URL : changez-la dans les variables du service web.",
      );
    const url = normaliseRunnerUrl(input.url);
    if (url !== row.url) {
      nextUrl = url;
      await assertAddressFree(url, row.id);
      ownerId = await spaceOwnerOf(row.spaceId);
      foreign = row.spaceId !== null && ownerId !== actor.id;
      if (foreign) {
        if (actor.role !== 'owner')
          throw new AppError('FORBIDDEN', SERVER_ADDRESS_GUARDS.ownerOnly);
        if (!input.password) throw new AppError('FORBIDDEN', SERVER_ADDRESS_GUARDS.password);
        await verifyOwnPassword(actor, input.password);
      }
    }
  }
  const inUse = row.spaceId !== null || row.status !== 'pending';
  const token = nextUrl && inUse && row.status !== 'retired' ? generateRunnerToken() : null;

  // Name and location first: their validation never leaves a renewed token unreturned.
  if (input.name !== undefined || input.location !== undefined) {
    await updateEnvironmentIdentity(
      row.id,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.location !== undefined ? { location: input.location || null } : {}),
      },
      { userId: actor.id, role: actor.role },
    );
  }
  const changes: Partial<typeof environments.$inferInsert> = {};
  if (nextUrl) changes.url = nextUrl;
  if (token) {
    // The previous token (and a rotation in progress) is refused from now on: no call ever carries
    // it to the new address, and the runner must be redeployed with the new one.
    Object.assign(changes, {
      tokenEncrypted: encryptRunnerToken(row.id, token),
      tokenHash: hashToken(token),
      nextTokenEncrypted: null,
      nextTokenHash: null,
      tokenRotatedAt: new Date(),
    });
  }
  if (input.maxConcurrentSessionsCap !== undefined) {
    changes.maxConcurrentSessionsCap = input.maxConcurrentSessionsCap;
    if (row.maxConcurrentSessions > input.maxConcurrentSessionsCap)
      changes.maxConcurrentSessions = input.maxConcurrentSessionsCap;
  }
  if (nextUrl) {
    // The address checks above hold for the row as it was read: if it was attributed, retired or
    // given another address meanwhile (concurrent administrator), nothing is written.
    const written = await db
      .update(environments)
      .set(changes)
      .where(
        and(
          eq(environments.id, row.id),
          row.spaceId === null ? isNull(environments.spaceId) : eq(environments.spaceId, row.spaceId),
          eq(environments.status, row.status),
          row.url === null ? isNull(environments.url) : eq(environments.url, row.url),
        ),
      )
      .returning({ id: environments.id });
    if (written.length === 0) {
      throw new AppError(
        'CONFLICT',
        'Ce serveur vient de changer : rouvrez-le, puis réessayez.',
      );
    }
  } else if (Object.keys(changes).length > 0) {
    await db.update(environments).set(changes).where(eq(environments.id, row.id));
  }
  if (Object.keys(changes).length > 0) {
    invalidateServer(row.id, [ownerId]);
    if (nextUrl) {
      // Another host (or machine) behind the server: guard list and the space's CLI state follow.
      invalidateSsrfCache();
      await resetSpaceMcpState(row.spaceId);
    }
    const name = input.name ?? row.name;
    await audit({
      action: 'admin.server_updated',
      summary: `serveur « ${name} » modifié : ${[
        nextUrl
          ? `adresse interne${token ? ' (jeton renouvelé : les anciens sont refusés)' : ''}`
          : null,
        changes.maxConcurrentSessionsCap !== undefined
          ? `plafond de ${changes.maxConcurrentSessionsCap} sessions parallèles`
          : null,
      ]
        .filter(Boolean)
        .join(', ')}`,
      actorUserId: actor.id,
      subjectUserId: nextUrl ? ownerId : null,
      targetType: 'environment',
      targetId: row.id,
      environmentId: row.id,
      metadata: {
        ...(nextUrl ? { url: nextUrl, previousUrl: row.url, rotated: token !== null } : {}),
        ...(changes.maxConcurrentSessionsCap !== undefined
          ? { cap: changes.maxConcurrentSessionsCap }
          : {}),
      },
    });
    if (nextUrl) {
      await notifyServerChange(row, actor, {
        title: `L'adresse interne de votre serveur ${name} a été modifiée par un administrateur.`,
        body: token
          ? "Son jeton a été renouvelé : le runner doit être redéployé avec le nouveau. Si vous n'êtes pas au courant, prévenez un administrateur."
          : "Si vous n'êtes pas au courant, prévenez un administrateur.",
      });
    }
  } else {
    invalidateServer(row.id);
  }
  return { server: await getServer(actor, row.id), token };
}

// ---------------------------------------------------------------------------------------------
// Retirer
// ---------------------------------------------------------------------------------------------

/** Retires a server (never reused afterwards). Refused while active projects live on it, and for the default server. */
export async function retireServer(
  actor: AdminActor,
  environmentId: string,
): Promise<AdminServerView> {
  assertAdminMutation(actor);
  if (!UUID_PATTERN.test(environmentId)) throw new AppError('NOT_FOUND', NOT_FOUND_SERVER);
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(environments)
      .where(eq(environments.id, environmentId))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND', NOT_FOUND_SERVER);
    if (row.status === 'retired') return { row, changed: false, ownerId: null as string | null };
    if (row.isDefault)
      throw new AppError('CONFLICT', 'Le serveur par défaut (RUNNER_URL) ne peut pas être retiré.');
    const [projectCount] = await tx
      .select({ total: count() })
      .from(projects)
      .where(and(eq(projects.environmentId, row.id), isNull(projects.archivedAt)));
    const total = Number(projectCount?.total ?? 0);
    if (total > 0) {
      throw new AppError(
        'CONFLICT',
        `${total === 1 ? 'Un projet actif vit' : `${total} projets actifs vivent`} sur ce serveur : archivez-${total === 1 ? 'le' : 'les'} d'abord.`,
      );
    }
    await tx.update(environments).set({ status: 'retired' }).where(eq(environments.id, row.id));
    await disableRunnerRoleLogin(tx, row.dbRole);
    const [owner] = row.spaceId
      ? await tx
          .select({ id: spaces.ownerUserId })
          .from(spaces)
          .where(eq(spaces.id, row.spaceId))
          .limit(1)
      : [];
    return { row, changed: true, ownerId: owner?.id ?? null };
  });
  invalidateServer(environmentId, [outcome.ownerId, ...(await linkedUserIds(environmentId))]);
  if (outcome.changed) {
    // NOLOGIN only refuses new connections: the ones its runner (or a session) still holds are closed.
    const connections = await closeRunnerRoleConnections(outcome.row.dbRole);
    await resetSpaceMcpState(outcome.row.spaceId);
    await audit({
      action: 'admin.server_retired',
      summary: `serveur « ${outcome.row.name} » retiré${refusedConnectionsNote(connections.refused)}`,
      actorUserId: actor.id,
      subjectUserId: outcome.ownerId,
      targetType: 'environment',
      targetId: environmentId,
      environmentId,
      metadata: { closedConnections: connections.closed, refusedConnections: connections.refused },
    });
  }
  return getServer(actor, environmentId);
}

// ---------------------------------------------------------------------------------------------
// Accès base restreint
// ---------------------------------------------------------------------------------------------

export interface RestrictedDatabaseAccess {
  id: string;
  dbRole: string;
  /** RUNNER_DATABASE_URL of the runner — shown once. */
  databaseUrl: string;
}

/**
 * Restricted database access of a server (the default one in practice): creates its role, or gives
 * the existing one a new password, and returns the DSN to put in RUNNER_DATABASE_URL (shown once).
 * The warning disappears once the runner's heartbeat reports `database.restricted` and PostgreSQL
 * confirms it (db-access.ts). A new password closes the connections opened with the old one.
 */
export async function restrictServerDatabase(
  actor: AdminActor,
  environmentId: string,
): Promise<RestrictedDatabaseAccess> {
  assertAdminMutation(actor);
  const row = await loadServer(environmentId);
  if (row.status === 'retired') throw new AppError('CONFLICT', 'Ce serveur est retiré.');
  const role = row.dbRole ?? generateRunnerRoleName();
  const password = generateRunnerRolePassword();
  try {
    await db.transaction(async (tx) => {
      if (row.dbRole) {
        await resetRunnerRolePassword(tx, role, password);
      } else {
        await tx
          .update(environments)
          .set({ dbRole: role })
          .where(and(eq(environments.id, row.id), isNull(environments.dbRole)));
        await createRunnerRole(tx, role, password);
      }
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw roleRefusal(error);
  }
  // A new password: the connections opened with the old one (a DSN that leaked) are closed now.
  const connections = row.dbRole
    ? await closeRunnerRoleConnections(role)
    : { closed: 0, refused: 0 };
  await audit({
    action: 'admin.server_database_restricted',
    summary: `accès base restreint ${row.dbRole ? 'renouvelé' : 'créé'} pour le serveur « ${row.name} » (${role})${refusedConnectionsNote(connections.refused)}`,
    actorUserId: actor.id,
    subjectUserId: await spaceOwnerOf(row.spaceId),
    targetType: 'environment',
    targetId: row.id,
    environmentId: row.id,
    metadata: {
      dbRole: role,
      closedConnections: connections.closed,
      refusedConnections: connections.refused,
    },
  });
  return { id: row.id, dbRole: role, databaseUrl: runnerDatabaseUrl(role, password) };
}
