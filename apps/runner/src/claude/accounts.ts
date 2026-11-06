import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { environmentSpaces, environments, type Database } from '@nuera/db';
import { isPathInside } from '@nuera/shared/paths';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { RunnerEnvironment } from '../environment';
import { RunnerError } from '../errors';
import { PLATFORM } from '../safety/paths';

/**
 * One Claude Code connection per account of the server (lot P1, docs/MULTICOMPTE.md §14 P1).
 *
 * A server can work for several accounts (`environment_spaces`). Every `claude` process the runner
 * starts for an account — sessions, resumes, login / status / MCP login terminals, `auth status`,
 * `mcp …`, shells and project commands — gets THAT account's `CLAUDE_CONFIG_DIR`, never another's:
 *
 * - the server's first account (`environments.space_id`, pinned in `<NUERA_DATA_DIR>/
 *   claude-compte-principal.json` the first time it is seen) keeps the existing CLI folder: the one of
 *   NUERA_CLAUDE_CONFIG_DIR, or the process default (`~/.claude` + `~/.claude.json` of the runner's
 *   HOME) — pointed to, never moved, read or copied (CLAUDE.md rule 1), so its login survives the
 *   update untouched;
 * - every other account gets `<accounts root>/<space id>/` (0700; root 0700): NUERA_CLAUDE_ACCOUNTS_DIR,
 *   else `<NUERA_CLAUDE_CONFIG_DIR>-comptes`, else `~/claude-comptes` (the persistent HOME volume in
 *   production). A link planted there is refused, never followed.
 *
 * The account of a request is never chosen by a browser: sessions, shells and runs take their
 * project's space; the Claude routes take the `spaceId` the web sends, checked against the server's
 * rows (`environment_spaces`, RLS by server for a restricted role). Without `spaceId`, only a server
 * with a single account (or none yet) answers: several accounts → VALIDATION, never a guess.
 *
 * Isolation limit (docs/SECURITY.md): every account folder belongs to the runner's Linux user, so a
 * hostile process of one account could read another's folder. Folders are 0700 against other users
 * only; a separate uid or sandbox per account is the documented follow-up.
 */

export interface ClaudeAccount {
  /** Cache key: the space id, or `serveur` for the server's own folder (no account yet). */
  key: string;
  /** Personal space of the account (null: server not assigned yet). */
  spaceId: string | null;
  /** CLAUDE_CONFIG_DIR of its processes; null = the process default (first account in production). */
  configDir: string | null;
  /** The server's first account, on the folder that existed before shared servers. */
  primary: boolean;
}

export interface ClaudeAccountsDeps {
  db: Database;
  environment: { readonly id: string; readonly current: RunnerEnvironment | null };
  /** NUERA_CLAUDE_CONFIG_DIR (null in production: the process default). */
  legacyDir: string | null;
  /** NUERA_CLAUDE_ACCOUNTS_DIR (null: derived, see the class comment). */
  accountsRoot: string | null;
  dataDir: string;
  logger: Logger;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINKS_TTL_MS = 10_000;
export const PRIMARY_MARKER = 'claude-compte-principal.json';

/** Root of the account folders (see {@link ClaudeAccounts}). */
export function accountsRootFor(input: { legacyDir: string | null; accountsRoot: string | null }): string {
  if (input.accountsRoot) return path.resolve(input.accountsRoot);
  if (input.legacyDir) return `${path.resolve(input.legacyDir).replace(/[\\/]+$/, '')}-comptes`;
  return path.join(os.homedir(), 'claude-comptes');
}

export class ClaudeAccounts {
  readonly root: string;
  private links: { at: number; environmentId: string; spaces: string[] } | null = null;
  private primarySpace: string | null | undefined = undefined;

  constructor(private readonly deps: ClaudeAccountsDeps) {
    this.root = accountsRootFor(deps);
  }

  /** Spaces this server works for (cached 10 s; {@link invalidate} after a change). */
  async spaces(options: { fresh?: boolean } = {}): Promise<string[]> {
    const environmentId = this.deps.environment.id;
    if (!options.fresh && this.links && this.links.environmentId === environmentId && Date.now() - this.links.at < LINKS_TTL_MS) {
      return this.links.spaces;
    }
    const rows = await this.deps.db
      .select({ spaceId: environmentSpaces.spaceId })
      .from(environmentSpaces)
      .where(eq(environmentSpaces.environmentId, environmentId));
    const spaces = rows.map((row) => row.spaceId.toLowerCase()).sort();
    this.links = { at: Date.now(), environmentId, spaces };
    return spaces;
  }

  invalidate(): void {
    this.links = null;
  }

  /**
   * Account of `spaceId` (a project's space, or what the web sent). NOT_FOUND when that account does
   * not work on this server (same answer as an unknown one).
   */
  async forSpace(spaceId: string): Promise<ClaudeAccount> {
    const id = spaceId.trim().toLowerCase();
    if (!UUID_RE.test(id)) throw notFound();
    let spaces = await this.spaces();
    if (!spaces.includes(id)) spaces = await this.spaces({ fresh: true });
    if (!spaces.includes(id)) throw notFound();
    if ((await this.primary()) === id) return { key: id, spaceId: id, configDir: this.deps.legacyDir, primary: true };
    return { key: id, spaceId: id, configDir: await this.ensureFolder(id), primary: false };
  }

  /**
   * Account of a Claude route: `spaceId` when given; otherwise the only account of the server, or
   * the server's own folder while it has none. Several accounts and no `spaceId`: refused.
   */
  async forRequest(spaceId: string | null | undefined): Promise<ClaudeAccount> {
    if (spaceId) return this.forSpace(spaceId);
    const spaces = await this.spaces();
    if (spaces.length === 1) return this.forSpace(spaces[0]!);
    if (spaces.length === 0) return { key: 'serveur', spaceId: null, configDir: this.deps.legacyDir, primary: true };
    throw new RunnerError('VALIDATION', "Ce serveur travaille pour plusieurs comptes : précisez le compte de la connexion Claude Code.", {
      reason: 'CLAUDE_ACCOUNT_REQUIRED',
    });
  }

  /** Every account of the server (common configuration, start-up status). */
  async all(): Promise<ClaudeAccount[]> {
    const accounts: ClaudeAccount[] = [];
    for (const spaceId of await this.spaces({ fresh: true })) {
      try {
        accounts.push(await this.forSpace(spaceId));
      } catch (error) {
        this.deps.logger.warn({ err: error, spaceId }, 'compte Claude : dossier de configuration indisponible');
      }
    }
    return accounts;
  }

  /**
   * The account left the server: `signOut` runs `claude auth logout` with its folder (the CLI's own
   * flow, nothing read), then the folder is removed. Refused while it still works on the server, and
   * never for the first account's folder (the server is retired instead).
   */
  async forget(
    spaceId: string,
    signOut: (account: ClaudeAccount) => Promise<boolean>,
    options: { deleted?: boolean } = {},
  ): Promise<{ removed: boolean; signedOut: boolean }> {
    const id = spaceId.trim().toLowerCase();
    if (!UUID_RE.test(id)) throw notFound();
    const linked = (await this.spaces({ fresh: true })).includes(id);
    // A deleted account keeps its row (its archived projects) but must not keep its login here.
    if (linked && !options.deleted) {
      throw new RunnerError('CONFLICT', 'Ce compte travaille encore sur ce serveur : retirez-le du serveur avant.', { reason: 'CLAUDE_ACCOUNT_IN_USE' });
    }
    if ((await this.primary()) === id) {
      // The first account's folder is the server's original one: signed out, never removed.
      if (!options.deleted) return { removed: false, signedOut: false };
      const signedOut = await signOut({ key: id, spaceId: id, configDir: this.deps.legacyDir, primary: true }).catch(() => false);
      return { removed: false, signedOut };
    }
    const folder = this.folderOf(id);
    const info = await lstat(folder).catch(() => null);
    if (!info) return { removed: false, signedOut: false };
    if (!info.isDirectory()) throw new RunnerError('CONFLICT', "Le dossier de configuration de ce compte n'est pas un dossier : vérifiez le serveur.");
    const signedOut = await signOut({ key: id, spaceId: id, configDir: folder, primary: false }).catch(() => false);
    await rm(folder, { recursive: true, force: true });
    this.deps.logger.info({ spaceId: id, signedOut }, 'compte Claude retiré du serveur : dossier de configuration supprimé');
    return { removed: true, signedOut };
  }

  /**
   * Start-up cleanup: the folder of an account that no longer works on this server (removed while the
   * runner was unreachable) is signed out and removed. Only `<root>/<uuid>` folders are considered;
   * nothing happens when the accounts cannot be read.
   */
  async sweep(signOut: (account: ClaudeAccount) => Promise<boolean>): Promise<number> {
    let linked: string[];
    try {
      linked = await this.spaces({ fresh: true });
    } catch {
      return 0;
    }
    const primary = await this.primary().catch(() => null);
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      const id = entry.name.toLowerCase();
      if (!entry.isDirectory() || !UUID_RE.test(id) || linked.includes(id) || id === primary) continue;
      const result = await this.forget(id, signOut).catch(() => null);
      if (result?.removed) removed += 1;
    }
    return removed;
  }

  /**
   * Cheap mitigation of the same-uid limit (docs/SECURITY.md): permission rules given to a session's
   * `--settings` that deny Claude's own file tools (Read, Grep, Glob, Edit, Write) on the Claude folders
   * of the OTHER accounts of the server — and, for an account added to a shared server, the server's
   * original folder (`~/.claude`, `~/.claude.json`). They do not stop a shell command (`cat`): only a
   * separate uid or sandbox per account would (follow-up). Empty on a server with one account.
   */
  async isolationDenyRules(account: ClaudeAccount): Promise<string[]> {
    if (process.platform === 'win32') return [];
    const spaces = await this.spaces();
    if (spaces.length <= 1) return [];
    const folders: string[] = [];
    for (const spaceId of spaces) {
      if (spaceId === account.spaceId) continue;
      if ((await this.primary()) === spaceId) {
        const legacy = this.deps.legacyDir ?? path.join(os.homedir(), '.claude');
        folders.push(legacy);
        if (!this.deps.legacyDir) folders.push(path.join(os.homedir(), '.claude.json'));
      } else {
        folders.push(this.folderOf(spaceId));
      }
    }
    const rules: string[] = [];
    for (const target of folders) {
      // `//abs/path` = absolute path in Claude Code permission rules.
      const pattern = target.endsWith('.json') ? `/${target}` : `/${target}/**`;
      rules.push(`Read(${pattern})`, `Edit(${pattern})`);
    }
    return rules;
  }

  /** Folder of a non-primary account (never created here). */
  folderOf(spaceId: string): string {
    const folder = path.join(this.root, spaceId);
    if (!isPathInside(this.root, folder, PLATFORM, { allowEqual: false })) throw notFound();
    return folder;
  }

  /**
   * The server's first account, pinned once: a later change of `environments.space_id` (a server
   * re-assigned before any project) never hands the existing login to someone else.
   */
  async primary(): Promise<string | null> {
    if (this.primarySpace !== undefined && this.primarySpace !== null) return this.primarySpace;
    const file = path.join(this.deps.dataDir, PRIMARY_MARKER);
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { environmentId?: unknown; spaceId?: unknown };
      if (typeof parsed.spaceId === 'string' && UUID_RE.test(parsed.spaceId.toLowerCase())) {
        this.primarySpace = parsed.spaceId.toLowerCase();
        return this.primarySpace;
      }
      throw new Error('marqueur illisible');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Unreadable marker: nobody gets the existing folder until an operator looks at it.
        this.deps.logger.error({ file }, "compte principal illisible : le dossier Claude existant n'est attribué à aucun compte");
        this.primarySpace = null;
        return null;
      }
    }
    // Read from the database, never from the cached row: right after the first assignment the cached
    // `space_id` is still null, and the first account would otherwise get a new, empty folder.
    const environmentId = this.deps.environment.id;
    const [row] = await this.deps.db
      .select({ spaceId: environments.spaceId })
      .from(environments)
      .where(eq(environments.id, environmentId))
      .limit(1);
    const spaceId = row?.spaceId?.toLowerCase() ?? null;
    if (!spaceId) return null;
    await mkdir(this.deps.dataDir, { recursive: true });
    const marker = { environmentId, spaceId, pinnedAt: new Date().toISOString() };
    await writeFile(file, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    this.primarySpace = undefined;
    return this.primary();
  }

  private async ensureFolder(spaceId: string): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertRealFolder(this.root);
    await chmod(this.root, 0o700).catch(() => undefined);
    const folder = this.folderOf(spaceId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await assertRealFolder(folder);
    await chmod(folder, 0o700).catch(() => undefined);
    return folder;
  }
}

function notFound(): RunnerError {
  return new RunnerError('NOT_FOUND', 'Compte introuvable sur ce serveur.');
}

async function assertRealFolder(folder: string): Promise<void> {
  const info = await lstat(folder);
  if (!info.isDirectory()) {
    throw new RunnerError('CONFLICT', `Le dossier de configuration Claude ${folder} est un lien ou un fichier : refusé.`, { reason: 'CLAUDE_ACCOUNT_FOLDER' });
  }
}
