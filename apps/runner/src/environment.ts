import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appSettings, createDb, environments, type Database, type EnvironmentCapabilities, type EnvironmentStatus } from '@nuera/db';
import { RUNNER_CONTRACT_VERSION, type RunnerEnvironmentRef, type RunnerState } from '@nuera/shared/runner';
import { hashToken, tokenFingerprint } from '@nuera/shared/tokens';
import { eq, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { RunnerConfig } from './config';
import { RunnerError } from './errors';

/**
 * Identity of the runner (docs/MULTICOMPTE.md §4). A runner serves exactly one « serveur » (row of
 * `environments`), found by `sha256(RUNNER_TOKEN)` in `token_hash` or `next_token_hash` (rotation).
 * It never claims a row by itself: an unknown or retired token keeps it in standby (health only).
 * One live runner per server (advisory lock on a dedicated connection), and its folders carry a
 * marker so that two servers never share a data dir or a projects root.
 */

/** Columns read from `environments` (explicit: a restricted role cannot read the token ciphertexts). */
export interface RunnerEnvironment {
  id: string;
  name: string;
  spaceId: string | null;
  status: EnvironmentStatus;
  isDefault: boolean;
  maxConcurrentSessions: number;
  sessionMemoryLimitMb: number | null;
}

export interface EnvironmentSettings {
  maxConcurrentSessions: number;
  sessionMemoryLimitMb: number | null;
}

/** What the services need: the server id for every query, its settings, the « disabled » guard. */
export interface EnvironmentScope {
  /** Id of the server; throws (503) while the runner is not serving. */
  readonly id: string;
  settings(): Promise<EnvironmentSettings>;
  /** Refuses new work (session, clone, worktree, run, shell) on a suspended server. */
  assertCanStartWork(): Promise<void>;
  /** `app_settings.force_block_bypass_permissions` (instance); true (blocked) when unreadable. */
  forceBlockBypass(): Promise<boolean>;
}

/**
 * - `unregistered`: token unknown or server retired (health only, retried every 15 s);
 * - `waiting_lease`: registered, another runner of the same server still holds the lease;
 * - `starting`: lease held, start-up tasks (markers, reconciliation) running;
 * - `ready`: serving every route.
 */
export type EnvironmentPhase = 'unregistered' | 'waiting_lease' | 'starting' | 'ready';

/** A configuration that must stop the runner (never retried). */
export class RunnerFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerFatalError';
  }
}

export interface DatabaseAccess {
  /** `current_user` of the runner's connections. */
  role: string;
  /** Neither superuser nor owner (member) of the tables: the restricted role of MULTICOMPTE §11. */
  restricted: boolean;
}

export const MARKER_FILE = '.nuera-environment';
const SETTINGS_TTL_MS = 15_000;
const STATUS_TTL_MS = 10_000;
const DISABLED_STATUSES = new Set<EnvironmentStatus>(['suspended', 'retired']);

/** SQLSTATE 42883: `nuera_runner_try_lease()` missing (database not yet at migration 0005). */
const UNDEFINED_FUNCTION = '42883';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const columns = {
  id: environments.id,
  name: environments.name,
  spaceId: environments.spaceId,
  status: environments.status,
  isDefault: environments.isDefault,
  maxConcurrentSessions: environments.maxConcurrentSessions,
  sessionMemoryLimitMb: environments.sessionMemoryLimitMb,
};

type LeaseClient = Database;
type ReservedSql = Awaited<ReturnType<Database['$client']['reserve']>>;

export class EnvironmentContext implements EnvironmentScope {
  /** First 8 hex characters of sha256(token): shown by the administration, logged in standby. */
  readonly fingerprint: string;
  private readonly tokenHash: string;
  private record: RunnerEnvironment | null = null;
  private phaseValue: EnvironmentPhase = 'unregistered';
  private refreshedAt = 0;
  private refreshing: Promise<RunnerEnvironment | null> | null = null;
  /** `viaFunction`: taken through `nuera_runner_try_lease()` (restricted role, migration 0005). */
  private lease: { client: LeaseClient; reserved: ReservedSql; environmentId: string; viaFunction: boolean } | null = null;
  private access: DatabaseAccess | null = null;
  /** Name of the server holding the lease when it was refused (standby copy). */
  private leaseBlockedBy: string | null = null;
  /** Stops the process (set by buildRunner): a fatal identity change found by {@link refresh}. */
  private fatalHandler: ((error: RunnerFatalError) => void) | null = null;

  constructor(
    private readonly deps: { db: Database; config: RunnerConfig; logger: Logger },
  ) {
    this.tokenHash = hashToken(deps.config.token);
    this.fingerprint = tokenFingerprint(deps.config.token);
  }

  get phase(): EnvironmentPhase {
    return this.phaseValue;
  }

  setPhase(phase: EnvironmentPhase): void {
    this.phaseValue = phase;
  }

  /**
   * Called when a re-read of the row ({@link refresh}: heartbeat, settings, status guard) finds a
   * fatal configuration (the token now designates another server, or several): the runner must stop
   * rather than keep serving under an identity it no longer has.
   */
  onFatal(handler: (error: RunnerFatalError) => void): void {
    this.fatalHandler = handler;
  }

  /** The server, once found (kept while the runner waits for the lease or starts). */
  get current(): RunnerEnvironment | null {
    return this.record;
  }

  get id(): string {
    if (!this.record || this.phaseValue === 'unregistered') throw this.notServingError();
    return this.record.id;
  }

  ref(): RunnerEnvironmentRef | null {
    return this.record && this.phaseValue !== 'unregistered' ? { id: this.record.id, name: this.record.name } : null;
  }

  /** `/v1/health` state. */
  get state(): RunnerState {
    if (this.phaseValue === 'unregistered' || !this.record) return 'unregistered';
    if (this.phaseValue !== 'ready') return 'starting';
    return DISABLED_STATUSES.has(this.record.status) ? 'disabled' : 'ready';
  }

  get serving(): boolean {
    return this.phaseValue === 'ready';
  }

  /** Answer of every route but `/v1/health` while the runner does not serve. */
  notServingError(): RunnerError {
    if (this.phaseValue === 'waiting_lease' && this.record) {
      return new RunnerError('UPSTREAM', `Un autre runner du serveur « ${this.leaseBlockedBy ?? this.record.name} » est encore actif : attente de son arrêt…`, {
        status: 503,
        reason: 'ENVIRONMENT_STARTING',
      });
    }
    if (this.phaseValue === 'starting' && this.record) {
      return new RunnerError('UPSTREAM', `Le runner du serveur « ${this.record.name} » démarre : réessayez dans un instant.`, {
        status: 503,
        reason: 'ENVIRONMENT_STARTING',
      });
    }
    return new RunnerError(
      'UPSTREAM',
      `Ce runner n'est rattaché à aucun serveur. Enregistrez-le depuis Administration, rubrique Serveurs (empreinte du jeton : ${this.fingerprint}).`,
      { status: 503, reason: 'ENVIRONMENT_UNREGISTERED' },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------------------------

  /**
   * Looks the server up by the hash of RUNNER_TOKEN (current or rotating token). Unknown or retired:
   * null. NUERA_ENVIRONMENT_ID, when set, must name that server (fatal otherwise).
   */
  async lookup(): Promise<RunnerEnvironment | null> {
    const rows = await this.deps.db
      .select(columns)
      .from(environments)
      .where(or(eq(environments.tokenHash, this.tokenHash), eq(environments.nextTokenHash, this.tokenHash)))
      .limit(2);
    const [row] = rows;
    if (!row) return null;
    if (rows.length > 1) {
      throw new RunnerFatalError('Le jeton de ce runner correspond à plusieurs serveurs : renouvelez-le depuis Administration, rubrique Serveurs.');
    }
    const expected = this.deps.config.environmentId;
    if (expected && expected.toLowerCase() !== row.id.toLowerCase()) {
      throw new RunnerFatalError('NUERA_ENVIRONMENT_ID ne correspond pas au serveur de ce jeton : vérifiez la configuration du runner.');
    }
    if (row.status === 'retired') return null;
    return row;
  }

  /** First resolution (boot, standby polling): records the server or stays unregistered. */
  async resolve(): Promise<RunnerEnvironment | null> {
    const found = await this.lookup();
    this.refreshedAt = Date.now();
    if (!found) {
      this.record = null;
      this.phaseValue = 'unregistered';
      return null;
    }
    if (this.record && this.record.id !== found.id) {
      throw new RunnerFatalError('Le jeton de ce runner désigne désormais un autre serveur : redémarrez le runner.');
    }
    this.record = found;
    if (this.phaseValue === 'unregistered') this.phaseValue = 'waiting_lease';
    return found;
  }

  /**
   * Re-reads the row (status, settings, rotation). A server retired (or a token revoked) while the
   * runner serves puts it back in standby: every route but health answers 503, nothing is killed.
   */
  async refresh(): Promise<RunnerEnvironment | null> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const found = await this.lookup();
        this.refreshedAt = Date.now();
        if (!found) {
          if (this.record && this.phaseValue !== 'unregistered') {
            this.deps.logger.error({ environmentId: this.record.id }, 'serveur retiré ou jeton révoqué : le runner ne sert plus que /v1/health');
          }
          this.record = null;
          this.phaseValue = 'unregistered';
          return null;
        }
        if (this.record && this.record.id !== found.id) {
          throw new RunnerFatalError('Le jeton de ce runner désigne désormais un autre serveur : redémarrez le runner.');
        }
        this.record = found;
        // Matched again (token re-registered, server restored) while this runner still holds its lease
        // and has already reconciled: it serves again. A runner that never booted goes through standby.
        if (this.phaseValue === 'unregistered' && this.lease?.environmentId === found.id) {
          this.phaseValue = 'ready';
          this.deps.logger.info({ environmentId: found.id }, 'serveur de nouveau enregistré : le runner sert à nouveau');
        }
        return found;
      } catch (error) {
        if (error instanceof RunnerFatalError) this.fatalHandler?.(error);
        throw error;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async fresh(ttlMs: number): Promise<RunnerEnvironment> {
    if (!this.record || Date.now() - this.refreshedAt > ttlMs) {
      await this.refresh().catch((error: unknown) => {
        if (error instanceof RunnerFatalError) throw error;
        // Database hiccup: keep the last known row.
        this.deps.logger.warn({ err: error }, 'serveur : relecture impossible, dernière valeur gardée');
      });
    }
    if (!this.record || this.phaseValue === 'unregistered') throw this.notServingError();
    return this.record;
  }

  /** Sessions in parallel and memory ceiling of this server (its own row, cached briefly). */
  async settings(): Promise<EnvironmentSettings> {
    const env = await this.fresh(SETTINGS_TTL_MS);
    return { maxConcurrentSessions: env.maxConcurrentSessions, sessionMemoryLimitMb: env.sessionMemoryLimitMb };
  }

  async assertCanStartWork(): Promise<void> {
    const env = await this.fresh(STATUS_TTL_MS);
    if (DISABLED_STATUSES.has(env.status)) {
      throw new RunnerError('FORBIDDEN', 'Ce serveur est désactivé : aucune nouvelle session, aucun clonage ni aucune commande ne peut démarrer.', {
        reason: 'ENVIRONMENT_DISABLED',
      });
    }
  }

  async forceBlockBypass(): Promise<boolean> {
    try {
      const [row] = await this.deps.db
        .select({ force: appSettings.forceBlockBypassPermissions })
        .from(appSettings)
        .where(eq(appSettings.id, 1))
        .limit(1);
      return row?.force ?? false;
    } catch (error) {
      // Fail closed: an instance-wide block that cannot be read is assumed to be on.
      this.deps.logger.warn({ err: error }, 'blocage forcé du mode sans autorisation illisible : mode refusé par précaution');
      return true;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Lease: one live runner per server
  // -------------------------------------------------------------------------------------------

  /**
   * `pg_try_advisory_lock(hashtextextended('nuera:environment:' || id, 0))` on a dedicated
   * connection (reserved: never recycled by the idle or lifetime timers). PostgreSQL releases it
   * when that connection dies, e.g. when the previous container is stopped.
   *
   * A restricted role (MULTICOMPTE §11) may not take advisory locks since migration 0005: it calls
   * `nuera_runner_try_lease()`, which takes the same key for its own server only. Against a
   * database not yet at 0005 (an additional server updated before the instance), the function does
   * not exist: the direct call is still allowed there.
   */
  async tryAcquireLease(): Promise<boolean> {
    const env = this.record;
    if (!env) return false;
    if (this.lease?.environmentId === env.id) return true;
    const { restricted } = await this.databaseAccess();
    const client = createDb(this.deps.config.databaseUrl, { max: 1, applicationName: `nuera-runner-lease:${env.id}` });
    let reserved: ReservedSql | null = null;
    try {
      reserved = await client.$client.reserve();
      const key = `nuera:environment:${env.id}`;
      let viaFunction = restricted;
      let row: { locked: boolean | null } | undefined;
      if (viaFunction) {
        try {
          [row] = await reserved<Array<{ locked: boolean | null }>>`select public.nuera_runner_try_lease() as locked`;
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code !== UNDEFINED_FUNCTION) throw error;
          viaFunction = false;
        }
      }
      if (!viaFunction) {
        [row] = await reserved<Array<{ locked: boolean }>>`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as locked`;
      }
      if (row?.locked) {
        this.lease = { client, reserved, environmentId: env.id, viaFunction };
        this.leaseBlockedBy = null;
        return true;
      }
      this.leaseBlockedBy = env.name;
      reserved.release();
      await client.$client.end({ timeout: 5 }).catch(() => undefined);
      return false;
    } catch (error) {
      reserved?.release();
      await client.$client.end({ timeout: 5 }).catch(() => undefined);
      throw error;
    }
  }

  /** false when the lease connection is gone (the lock went with it). */
  async checkLease(): Promise<boolean> {
    if (!this.lease) return false;
    try {
      await this.lease.reserved`select 1`;
      return true;
    } catch {
      return false;
    }
  }

  get holdsLease(): boolean {
    return this.lease !== null;
  }

  async releaseLease(): Promise<void> {
    const lease = this.lease;
    this.lease = null;
    if (!lease) return;
    try {
      if (lease.viaFunction) await lease.reserved`select public.nuera_runner_release_lease()`;
      else await lease.reserved`select pg_advisory_unlock(hashtextextended(${`nuera:environment:${lease.environmentId}`}, 0))`;
    } catch {
      // connection already gone: so is the lock
    }
    lease.reserved.release();
    await lease.client.$client.end({ timeout: 5 }).catch(() => undefined);
  }

  // -------------------------------------------------------------------------------------------
  // Folder markers
  // -------------------------------------------------------------------------------------------

  /**
   * `.nuera-environment` in NUERA_DATA_DIR and NUERA_PROJECTS_ROOT: written on the first start,
   * refused when another server's id is inside (two servers never share sessions, tmux files or
   * clones).
   */
  async claimMarkers(dirs: { dataDir: string; projectsRoot: string }): Promise<void> {
    const env = this.record;
    if (!env) throw this.notServingError();
    const targets = [
      { dir: dirs.dataDir, label: 'Le dossier de données', variable: 'NUERA_DATA_DIR' },
      { dir: dirs.projectsRoot, label: 'Le dossier des projets', variable: 'NUERA_PROJECTS_ROOT' },
    ];
    for (const target of targets) {
      const file = path.join(target.dir, MARKER_FILE);
      const existing = await readMarker(file);
      if (existing === 'unreadable') {
        throw new RunnerFatalError(
          `Le marqueur ${file} est illisible : vérifiez à quel serveur appartient ce dossier, puis supprimez ce fichier.`,
        );
      }
      if (existing && existing.environmentId.toLowerCase() !== env.id.toLowerCase()) {
        throw new RunnerFatalError(
          `${target.label} ${target.dir} appartient au serveur « ${existing.name ?? existing.environmentId} » : donnez un dossier propre à ce runner (${target.variable}).`,
        );
      }
      if (!existing) {
        await mkdir(target.dir, { recursive: true });
        const marker = { environmentId: env.id, name: env.name, createdAt: new Date().toISOString() };
        await writeFile(file, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }).catch(async (error: unknown) => {
          // Written meanwhile by another process: check it again.
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const raced = await readMarker(file);
          if (!raced || raced === 'unreadable' || raced.environmentId.toLowerCase() !== env.id.toLowerCase()) {
            throw new RunnerFatalError(`${target.label} ${target.dir} est revendiqué par un autre serveur : donnez un dossier propre à ce runner (${target.variable}).`);
          }
        });
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------------------------

  /** Role of the runner's connections, and whether it is the restricted role of §11. */
  async databaseAccess(): Promise<DatabaseAccess> {
    if (this.access) return this.access;
    const [row] = await this.deps.db.execute<{ role: string; superuser: boolean | null; owner: boolean | null }>(sql`
      select current_user::text as role,
        (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) as superuser,
        pg_catalog.pg_has_role(current_user, (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.environments'::regclass), 'MEMBER') as owner
    `);
    this.access = { role: row?.role ?? 'inconnu', restricted: !(row?.superuser ?? false) && !(row?.owner ?? false) };
    return this.access;
  }

  /**
   * Every 60 s: `last_seen_at`, versions, backend and capabilities of this server. Never touches
   * its status (only the administration does).
   */
  async heartbeat(info: { backend: 'tmux' | 'pty'; tools: Pick<EnvironmentCapabilities, 'claudeVersion' | 'gitVersion' | 'tmuxVersion'> }): Promise<void> {
    const env = this.record;
    if (!env || this.phaseValue === 'unregistered') return;
    const database = await this.databaseAccess();
    const capabilities: RunnerCapabilities = {
      hostname: os.hostname(),
      platform: process.platform,
      claudeVersion: info.tools.claudeVersion ?? null,
      gitVersion: info.tools.gitVersion ?? null,
      tmuxVersion: info.tools.tmuxVersion ?? null,
      database,
    };
    await this.deps.db
      .update(environments)
      .set({
        lastSeenAt: new Date(),
        runnerVersion: this.deps.config.version,
        contractVersion: RUNNER_CONTRACT_VERSION,
        backend: info.backend,
        capabilities,
      })
      .where(eq(environments.id, env.id));
  }
}

/** Capabilities written by the heartbeat: the admin console warns when `database.restricted` is false. */
export interface RunnerCapabilities extends EnvironmentCapabilities {
  database: DatabaseAccess;
}

async function readMarker(file: string): Promise<{ environmentId: string; name: string | null } | 'unreadable' | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return 'unreadable';
  }
  try {
    const parsed = JSON.parse(text) as { environmentId?: unknown; name?: unknown };
    if (typeof parsed.environmentId !== 'string' || !UUID_RE.test(parsed.environmentId)) return 'unreadable';
    return { environmentId: parsed.environmentId, name: typeof parsed.name === 'string' ? parsed.name : null };
  } catch {
    return 'unreadable';
  }
}
