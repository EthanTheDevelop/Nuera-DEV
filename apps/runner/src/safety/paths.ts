import { mkdirSync, realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  confineAbsolutePath,
  isAbsolutePath,
  isPathInside,
  normalizeRelativePath,
  relativeInside,
  resolveConfinedPath,
  type PathPlatform,
} from '@nuera/shared/paths';
import { RunnerError } from '../errors';

export const PLATFORM: PathPlatform = process.platform === 'win32' ? 'win32' : 'posix';

const guardOptions = (mustExist = true) => ({ platform: PLATFORM, realpath: (p: string) => realpath(p), mustExist });

/**
 * Path confinement for the runner: everything it reads or writes on disk lives under
 * NUERA_PROJECTS_ROOT (clones, worktrees) or NUERA_DATA_DIR (runtime files). Every path coming
 * from a request or from the database goes through these helpers (realpath based).
 */
export class PathGuard {
  readonly projectsRoot: string;
  readonly dataDir: string;

  constructor(projectsRoot: string, dataDir: string) {
    mkdirSync(projectsRoot, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    this.projectsRoot = realpathSync.native(projectsRoot);
    this.dataDir = realpathSync.native(dataDir);
  }

  /** Absolute path (from the DB or a request) that must be inside the projects root. */
  async confineProjectPath(candidate: string, options: { mustExist?: boolean } = {}): Promise<string> {
    try {
      return await confineAbsolutePath(path.resolve(candidate), [this.projectsRoot], guardOptions(options.mustExist ?? true));
    } catch (error) {
      throw asRunnerError(error, 'Chemin hors du dossier des projets.');
    }
  }

  /** Clone destination: absolute (inside the root) or relative to the projects root. Need not exist. */
  async resolveDestination(input: string): Promise<string> {
    try {
      if (isAbsolutePath(input, PLATFORM) || path.isAbsolute(input)) {
        const resolved = await confineAbsolutePath(path.resolve(input), [this.projectsRoot], guardOptions(false));
        if (!isPathInside(this.projectsRoot, resolved, PLATFORM, { allowEqual: false })) {
          throw new RunnerError('VALIDATION', 'La destination ne peut pas être le dossier des projets lui-même.', {
            reason: 'DESTINATION_OUTSIDE_ROOT',
          });
        }
        return resolved;
      }
      const rel = normalizeRelativePath(input, PLATFORM);
      if (!rel) {
        throw new RunnerError('VALIDATION', 'La destination ne peut pas être le dossier des projets lui-même.', {
          reason: 'DESTINATION_OUTSIDE_ROOT',
        });
      }
      return await resolveConfinedPath(this.projectsRoot, rel, guardOptions(false));
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      throw asRunnerError(error, 'Destination hors du dossier des projets.', 'DESTINATION_OUTSIDE_ROOT');
    }
  }

  /** Path relative to a worktree (file tree, file read, diff path). */
  async resolveInWorktree(worktreePath: string, relativePath: string, options: { mustExist?: boolean } = {}): Promise<string> {
    const root = await this.confineProjectPath(worktreePath);
    try {
      return await resolveConfinedPath(root, relativePath, guardOptions(options.mustExist ?? true));
    } catch (error) {
      throw asRunnerError(error, 'Chemin hors du worktree.');
    }
  }

  /** Path inside the runner data dir (runtime files). */
  async resolveInData(relativePath: string, options: { mustExist?: boolean } = {}): Promise<string> {
    try {
      return await resolveConfinedPath(this.dataDir, relativePath, guardOptions(options.mustExist ?? false));
    } catch (error) {
      throw asRunnerError(error, 'Chemin hors du dossier de données du runner.');
    }
  }

  /** Normalised relative path for git pathspecs (`:(literal)` prefixed by callers). */
  relativeForGit(relativePath: string): string {
    try {
      return normalizeRelativePath(relativePath, PLATFORM);
    } catch (error) {
      throw asRunnerError(error, 'Chemin invalide.');
    }
  }

  relativeInsideProjects(candidate: string): string | null {
    return relativeInside(this.projectsRoot, candidate, PLATFORM);
  }

  isInsideProjects(candidate: string): boolean {
    return isPathInside(this.projectsRoot, candidate, PLATFORM);
  }
}

function asRunnerError(error: unknown, fallback: string, reason = 'PATH_REJECTED'): RunnerError {
  if (error instanceof RunnerError) return error;
  const message = error instanceof Error && error.message ? error.message : fallback;
  const code = (error as { code?: string } | null)?.code;
  if (code === 'PATH_NOT_FOUND') return new RunnerError('NOT_FOUND', message, { reason });
  return new RunnerError('VALIDATION', message, { reason, detail: code });
}
