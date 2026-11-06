import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COMMON_RULES_FILE,
  COMMON_SKILL_LIMITS,
  COMMON_SKILL_MARKER,
  COMMON_SKILL_NAME,
  CommonConfigPayloadSchema,
  isSafeSkillPath,
  type CommonConfigPayload,
  type CommonConfigStatus,
  type CommonSkill,
} from '@nuera/shared/runner';
import type { Logger } from 'pino';
import { isPathInside } from '@nuera/shared/paths';
import { PLATFORM } from '../safety/paths';

/**
 * « Configuration Claude commune » on the disk of this server (lot K1). The web computes what applies
 * to the account of the server (audience, choices of its space); the runner fetches it
 * (`POST /api/internal/claude-config`, token of the server) at start-up, when the web announces a
 * change (`POST /v1/claude/config/sync`) and before a session starts with another hash than the one
 * written. It writes, atomically, ONLY:
 *
 * - `<CLAUDE_CONFIG_DIR>/skills/<name>/` for each common skill: the folder carries
 *   {@link COMMON_SKILL_MARKER}; a folder without it is the account's own skill and is never
 *   touched (reported as a conflict). A new version is written next to the folder, then swapped in by
 *   two renames; a removed skill disappears. Files are read-only (0444; 0555 for allowed scripts).
 * - `<CLAUDE_CONFIG_DIR>/rules/nuera-commun.md`: the « Par défaut » rules (user-level memory, loaded
 *   by the CLI before the project's CLAUDE.md). Other files of `rules/` are never touched.
 * - `<NUERA_DATA_DIR>/claude-commun/regles-imposees.md`: the « Imposé » rules, given to every session
 *   with `--append-system-prompt-file`.
 *
 * It never reads nor writes anything else of the Claude folder: not `.credentials.json`, not
 * `.claude.json`, not `settings.json` (CLAUDE.md rule 1) — {@link assertManagedTarget} refuses any
 * other path.
 */

export interface CommonConfigFetcher {
  claudeConfig(have: Array<{ name: string; hash: string }>): Promise<unknown | null>;
}

export interface CommonConfigDeps {
  /** NUERA_CLAUDE_CONFIG_DIR, else `~/.claude` of the runner's user. */
  claudeConfigDir: string | null;
  dataDir: string;
  web: CommonConfigFetcher;
  logger: Logger;
}

interface SkillMarker {
  managedBy: 'nuera-dev';
  id: string;
  name: string;
  version: number;
  hash: string;
}

const FORBIDDEN_NAMES = new Set(['.credentials.json', '.claude.json', 'settings.json', 'settings.local.json', 'CLAUDE.md']);
const SCRATCH_PREFIXES = ['.nuera-tmp-', '.nuera-old-'];

export const LOCKED_RULES_FILE = 'regles-imposees.md';

const emptyStatus = (): CommonConfigStatus => ({
  hash: null,
  revision: null,
  appliedAt: null,
  checkedAt: null,
  skills: [],
  conflicts: [],
  rules: { defaultFile: false, lockedFile: false, count: 0 },
  error: null,
});

export class CommonConfigSync {
  private status: CommonConfigStatus = emptyStatus();
  private running: Promise<CommonConfigStatus> | null = null;
  private loaded = false;

  constructor(private readonly deps: CommonConfigDeps) {}

  get configDir(): string {
    return this.deps.claudeConfigDir?.trim() || path.join(os.homedir(), '.claude');
  }
  get skillsDir(): string {
    return path.join(this.configDir, 'skills');
  }
  get rulesDir(): string {
    return path.join(this.configDir, 'rules');
  }
  get stateDir(): string {
    return path.join(this.deps.dataDir, 'claude-commun');
  }
  /** `--append-system-prompt-file` of the sessions, when « Imposé » rules apply. */
  get lockedRulesPath(): string {
    return path.join(this.stateDir, LOCKED_RULES_FILE);
  }

  /** Status of the last synchronisation (read from disk after a restart). */
  async current(): Promise<CommonConfigStatus> {
    await this.loadState();
    return this.status;
  }

  /** Locked rules file to pass to a session, or null. */
  lockedRulesFile(): string | null {
    return existsSync(this.lockedRulesPath) ? this.lockedRulesPath : null;
  }

  /**
   * Before a launch: the session must start with `hash`. Synchronises when the copy differs; a
   * failure is logged and the session starts with the copy on disk (never blocked by the web).
   */
  async ensure(hash: string | null | undefined): Promise<void> {
    await this.loadState();
    if (!hash || hash === this.status.hash) return;
    const status = await this.sync('launch');
    if (status.hash !== hash) {
      this.deps.logger.warn({ expected: hash.slice(0, 12), applied: status.hash?.slice(0, 12) ?? null }, 'configuration commune : la session démarre avec la copie du serveur');
    }
  }

  /** One synchronisation at a time; a call made during one waits for it, then runs again. */
  async sync(reason: 'changed' | 'manual' | 'launch' | 'start' = 'changed'): Promise<CommonConfigStatus> {
    while (this.running) await this.running.catch(() => undefined);
    const run = this.syncOnce(reason);
    this.running = run;
    try {
      return await run;
    } finally {
      if (this.running === run) this.running = null;
    }
  }

  private async syncOnce(reason: string): Promise<CommonConfigStatus> {
    await this.loadState();
    const checkedAt = new Date().toISOString();
    let raw: unknown;
    try {
      raw = await this.deps.web.claudeConfig(this.status.skills.map(({ name, hash }) => ({ name, hash })));
    } catch {
      raw = null;
    }
    if (raw === null) {
      this.status = { ...this.status, checkedAt, error: "Le web n'a pas transmis la configuration commune : la copie précédente reste en place." };
      return this.status;
    }
    const parsed = CommonConfigPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      this.status = { ...this.status, checkedAt, error: 'Configuration commune illisible : la copie précédente reste en place.' };
      this.deps.logger.warn({ issues: parsed.error.issues.slice(0, 3) }, 'configuration commune illisible');
      return this.status;
    }
    try {
      this.status = await this.apply(parsed.data, checkedAt);
      this.deps.logger.info(
        { reason, revision: parsed.data.revision, skills: this.status.skills.length, conflicts: this.status.conflicts.length },
        'configuration commune appliquée',
      );
    } catch (error) {
      this.status = { ...this.status, checkedAt, error: `Configuration commune non écrite : ${(error as Error).message}`.slice(0, 300) };
      this.deps.logger.warn({ err: error }, 'configuration commune non écrite');
    }
    await this.saveState();
    return this.status;
  }

  /** Writes a payload (exported for the tests through `sync`). */
  private async apply(payload: CommonConfigPayload, checkedAt: string): Promise<CommonConfigStatus> {
    const conflicts: CommonConfigStatus['conflicts'] = [];
    const installed: CommonConfigStatus['skills'] = [];
    // Nothing to write and no folder yet: the Claude folder is left exactly as it is.
    const touchSkills = payload.skills.length > 0 || existsSync(this.skillsDir);
    if (touchSkills) {
      await mkdir(this.skillsDir, { recursive: true });
      await this.assertRealDirectory(this.skillsDir);
      await this.removeScratch(this.skillsDir);
    }

    const wanted = new Map<string, CommonSkill>();
    for (const skill of payload.skills) {
      if (!COMMON_SKILL_NAME.test(skill.name) || wanted.has(skill.name)) {
        conflicts.push({ name: skill.name, reason: 'Nom de skill invalide ou en double.' });
        continue;
      }
      wanted.set(skill.name, skill);
    }

    let total = 0;
    for (const skill of wanted.values()) {
      const target = path.join(this.skillsDir, skill.name);
      const marker = await this.readMarker(target);
      if (existsSync(target) && !marker) {
        conflicts.push({ name: skill.name, reason: 'Un skill du même nom existe déjà sur ce serveur sans être géré par Nuera Dev : il est laissé tel quel.' });
        continue;
      }
      if (marker && marker.hash === skill.hash) {
        installed.push({ name: skill.name, version: marker.version, hash: marker.hash });
        continue;
      }
      if (!skill.files) {
        // The web believed we had it: next synchronisation will send the files.
        conflicts.push({ name: skill.name, reason: 'Fichiers non transmis : nouvel essai à la prochaine synchronisation.' });
        continue;
      }
      const refused = validateSkillFiles(skill);
      if (refused) {
        conflicts.push({ name: skill.name, reason: refused });
        continue;
      }
      total += skill.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
      if (total > COMMON_SKILL_LIMITS.maxTotalBytes) {
        conflicts.push({ name: skill.name, reason: 'Taille totale des skills dépassée.' });
        continue;
      }
      await this.writeSkill(target, skill);
      installed.push({ name: skill.name, version: skill.version, hash: skill.hash });
    }

    // Managed folders that no longer apply are removed; the account's own folders stay.
    for (const entry of touchSkills ? await readdir(this.skillsDir, { withFileTypes: true }) : []) {
      if (!entry.isDirectory() || wanted.has(entry.name)) continue;
      const folder = path.join(this.skillsDir, entry.name);
      if (await this.readMarker(folder)) await this.removeFolder(folder);
    }

    const defaultFile = await this.writeOrRemove(path.join(this.rulesDir, COMMON_RULES_FILE), payload.rules.defaultMarkdown, this.rulesDir);
    const lockedFile = await this.writeOrRemove(this.lockedRulesPath, payload.rules.lockedMarkdown, this.stateDir);
    return {
      hash: payload.hash,
      revision: payload.revision,
      appliedAt: new Date().toISOString(),
      checkedAt,
      skills: installed.sort((a, b) => a.name.localeCompare(b.name)),
      conflicts,
      rules: { defaultFile, lockedFile, count: payload.rules.items.length },
      error: null,
    };
  }

  /** New version in a scratch folder, then two renames (the CLI never sees a half-written skill). */
  private async writeSkill(target: string, skill: CommonSkill): Promise<void> {
    const scratch = path.join(this.skillsDir, `.nuera-tmp-${randomBytes(6).toString('hex')}`);
    this.assertManagedTarget(scratch);
    await mkdir(scratch, { recursive: true });
    try {
      for (const file of skill.files ?? []) {
        const destination = path.join(scratch, ...file.path.split('/'));
        if (!isPathInside(scratch, destination, PLATFORM, { allowEqual: false })) {
          throw new Error(`chemin refusé : ${file.path}`);
        }
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, file.content, { encoding: 'utf8', flag: 'wx' });
        await chmod(destination, file.executable ? 0o555 : 0o444).catch(() => undefined);
      }
      const marker: SkillMarker = { managedBy: 'nuera-dev', id: skill.id, name: skill.name, version: skill.version, hash: skill.hash };
      await writeFile(path.join(scratch, COMMON_SKILL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o444 });
      let previous: string | null = null;
      if (existsSync(target)) {
        previous = path.join(this.skillsDir, `.nuera-old-${randomBytes(6).toString('hex')}`);
        await rename(target, previous);
      }
      await rename(scratch, target);
      if (previous) await rm(previous, { recursive: true, force: true });
    } catch (error) {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async removeFolder(folder: string): Promise<void> {
    this.assertManagedTarget(folder);
    const doomed = path.join(this.skillsDir, `.nuera-old-${randomBytes(6).toString('hex')}`);
    await rename(folder, doomed);
    await rm(doomed, { recursive: true, force: true });
  }

  /** Leftovers of an interrupted synchronisation. */
  private async removeScratch(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && SCRATCH_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
        await rm(path.join(dir, entry.name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async readMarker(folder: string): Promise<SkillMarker | null> {
    try {
      const info = await lstat(folder);
      if (!info.isDirectory()) return null;
      const value = JSON.parse(await readFile(path.join(folder, COMMON_SKILL_MARKER), 'utf8')) as Partial<SkillMarker>;
      if (value.managedBy !== 'nuera-dev' || typeof value.hash !== 'string' || typeof value.version !== 'number' || typeof value.name !== 'string') return null;
      return value as SkillMarker;
    } catch {
      return null;
    }
  }

  /** Writes `content` atomically (temporary file + rename), or removes the file when content is null. */
  private async writeOrRemove(file: string, content: string | null, parent: string): Promise<boolean> {
    this.assertManagedTarget(file);
    if (content === null || content.trim() === '') {
      if (existsSync(file)) await rm(file, { force: true });
      return false;
    }
    await mkdir(parent, { recursive: true });
    await this.assertRealDirectory(parent);
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o644 });
    await rename(temporary, file);
    return true;
  }

  /** The skills / rules folders must be real folders (a link elsewhere is refused, never followed). */
  private async assertRealDirectory(dir: string): Promise<void> {
    const info = await lstat(dir);
    if (!info.isDirectory()) throw new Error(`${dir} n'est pas un dossier (lien refusé)`);
  }

  /**
   * Every path written or removed is inside `skills/`, `rules/nuera-commun.md` or the runner's own
   * folder, and is never a credential or account file of the CLI.
   */
  private assertManagedTarget(target: string): void {
    const base = path.basename(target);
    if (FORBIDDEN_NAMES.has(base)) throw new Error(`fichier protégé : ${base}`);
    const allowed =
      isPathInside(this.skillsDir, target, PLATFORM, { allowEqual: false }) ||
      path.resolve(target) === path.resolve(this.rulesDir, COMMON_RULES_FILE) ||
      isPathInside(this.stateDir, target, PLATFORM, { allowEqual: false });
    if (!allowed) throw new Error(`chemin hors de la configuration commune : ${target}`);
  }

  private async loadState(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const value = JSON.parse(await readFile(path.join(this.stateDir, 'state.json'), 'utf8')) as CommonConfigStatus;
      if (value && typeof value === 'object' && Array.isArray(value.skills)) this.status = { ...emptyStatus(), ...value };
    } catch {
      // never synchronised
    }
  }

  private async saveState(): Promise<void> {
    try {
      await mkdir(this.stateDir, { recursive: true });
      const file = path.join(this.stateDir, 'state.json');
      const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, JSON.stringify(this.status, null, 2), 'utf8');
      await rename(temporary, file);
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'état de la configuration commune non enregistré');
    }
  }
}

/** Why the files of a skill are refused (null when they are accepted). */
export function validateSkillFiles(skill: Pick<CommonSkill, 'files'>): string | null {
  const files = skill.files ?? [];
  if (!files.some((file) => file.path === 'SKILL.md')) return 'SKILL.md manquant.';
  if (files.length > COMMON_SKILL_LIMITS.maxFiles) return 'Trop de fichiers.';
  const seen = new Set<string>();
  let size = 0;
  for (const file of files) {
    if (!isSafeSkillPath(file.path) || file.path === COMMON_SKILL_MARKER) return `Chemin refusé : ${file.path}.`;
    const key = file.path.toLowerCase();
    if (seen.has(key)) return `Fichier en double : ${file.path}.`;
    // A file and a folder of the same name cannot both exist.
    for (const other of seen) if (other.startsWith(`${key}/`) || key.startsWith(`${other}/`)) return `Chemin en conflit : ${file.path}.`;
    seen.add(key);
    size += Buffer.byteLength(file.content, 'utf8');
  }
  if (size > COMMON_SKILL_LIMITS.maxSkillBytes) return 'Skill trop volumineux.';
  return null;
}
