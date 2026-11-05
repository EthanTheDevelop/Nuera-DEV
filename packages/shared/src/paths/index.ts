/**
 * Path guard helpers shared by the runner (enforcement) and the web app (early validation).
 *
 * This module is PURE (no `node:*` import) so it can be bundled anywhere. Real confinement
 * (`resolveConfinedPath`, `confineAbsolutePath`) needs the file system: the caller injects
 * `realpath` (the runner passes `fs.promises.realpath`). Symlinks are therefore resolved by the
 * OS and the *real* target must stay inside the *real* root — `..` traversal and symlink
 * escapes are both rejected.
 */

export type PathPlatform = 'posix' | 'win32';

export type PathGuardErrorCode =
  | 'PATH_INVALID'
  | 'PATH_ABSOLUTE'
  | 'PATH_TRAVERSAL'
  | 'PATH_OUTSIDE_ROOT'
  | 'PATH_NOT_FOUND';

export class PathGuardError extends Error {
  readonly code: PathGuardErrorCode;
  constructor(code: PathGuardErrorCode, message: string) {
    super(message);
    this.name = 'PathGuardError';
    this.code = code;
  }
}

export function isPathGuardError(error: unknown): error is PathGuardError {
  return error instanceof PathGuardError || (error as { name?: unknown } | null)?.name === 'PathGuardError';
}

const MAX_PATH_LENGTH = 4096;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Normalises a path *relative to a root* (as received from a query string or a form):
 * forward slashes, no empty or `.` segments. Rejects absolute paths, drive letters, UNC paths,
 * any `..` segment, NUL / control characters and (on win32) `:` inside a segment
 * (alternate data streams). `''` designates the root itself.
 */
export function normalizeRelativePath(input: string, platform: PathPlatform = 'posix'): string {
  if (typeof input !== 'string') throw new PathGuardError('PATH_INVALID', 'Chemin invalide.');
  if (input.length > MAX_PATH_LENGTH) throw new PathGuardError('PATH_INVALID', 'Chemin trop long.');
  if (CONTROL_CHARS.test(input)) throw new PathGuardError('PATH_INVALID', 'Le chemin contient des caractères de contrôle.');
  if (input.startsWith('/') || input.startsWith('\\') || /^[a-zA-Z]:/.test(input)) {
    throw new PathGuardError('PATH_ABSOLUTE', 'Un chemin relatif est attendu.');
  }
  const segments = input.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.');
  for (const segment of segments) {
    if (segment === '..') throw new PathGuardError('PATH_TRAVERSAL', 'Le chemin ne peut pas remonter hors du dossier.');
    if (platform === 'win32' && (segment.includes(':') || /[<>"|?*]/.test(segment))) {
      throw new PathGuardError('PATH_INVALID', 'Caractère interdit dans le chemin.');
    }
  }
  return segments.join('/');
}

/** `true` when {@link normalizeRelativePath} would accept the input. */
export function isSafeRelativePath(input: string, platform: PathPlatform = 'posix'): boolean {
  try {
    normalizeRelativePath(input, platform);
    return true;
  } catch {
    return false;
  }
}

/** Joins relative segments (each one normalised). */
export function joinRelativePath(...parts: string[]): string {
  return normalizeRelativePath(parts.filter((part) => part.length > 0).join('/'));
}

/** Parent of a normalised relative path (`'a/b'` → `'a'`, `'a'` → `''`). */
export function parentRelativePath(relativePath: string): string {
  const index = relativePath.lastIndexOf('/');
  return index === -1 ? '' : relativePath.slice(0, index);
}

/** Last segment of a path, whatever its separator. */
export function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** Lower-cased extension without the dot (`'Board.TSX'` → `'tsx'`, `'Makefile'` → `''`). */
export function extName(p: string): string {
  const name = baseName(p);
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index + 1).toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Absolute paths (platform aware, lexical)
// ---------------------------------------------------------------------------------------------

export function isAbsolutePath(p: string, platform: PathPlatform): boolean {
  if (platform === 'win32') return /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
  return p.startsWith('/');
}

function resolveDots(segments: string[]): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}

/**
 * Lexical normalisation of an absolute path: separators collapsed, `.`/`..` resolved (never above
 * the root), win32 drive letter upper-cased and `\\?\` prefix removed.
 */
export function normalizeAbsolutePath(p: string, platform: PathPlatform): string {
  if (typeof p !== 'string' || CONTROL_CHARS.test(p)) throw new PathGuardError('PATH_INVALID', 'Chemin invalide.');
  if (platform === 'win32') {
    let s = p.replace(/\//g, '\\');
    if (s.startsWith('\\\\?\\UNC\\')) s = `\\\\${s.slice(8)}`;
    else if (s.startsWith('\\\\?\\')) s = s.slice(4);
    const drive = /^([a-zA-Z]):(?:\\|$)/.exec(s);
    if (drive) {
      const segments = resolveDots(s.slice(2).split('\\'));
      return `${drive[1]!.toUpperCase()}:\\${segments.join('\\')}`;
    }
    const unc = /^\\\\([^\\]+)\\([^\\]+)(.*)$/.exec(s);
    if (unc) {
      const segments = resolveDots((unc[3] ?? '').split('\\'));
      const prefix = `\\\\${unc[1]}\\${unc[2]}`;
      return segments.length ? `${prefix}\\${segments.join('\\')}` : prefix;
    }
    throw new PathGuardError('PATH_INVALID', 'Un chemin absolu est attendu.');
  }
  if (!p.startsWith('/')) throw new PathGuardError('PATH_INVALID', 'Un chemin absolu est attendu.');
  return `/${resolveDots(p.split('/')).join('/')}`;
}

const sepOf = (platform: PathPlatform) => (platform === 'win32' ? '\\' : '/');
const foldCase = (p: string, platform: PathPlatform) => (platform === 'win32' ? p.toLowerCase() : p);

/** Lexical containment test on absolute paths (case-insensitive on win32). */
export function isPathInside(
  root: string,
  candidate: string,
  platform: PathPlatform,
  options: { allowEqual?: boolean } = {},
): boolean {
  const r = foldCase(normalizeAbsolutePath(root, platform), platform);
  const c = foldCase(normalizeAbsolutePath(candidate, platform), platform);
  if (c === r) return options.allowEqual ?? true;
  const sep = sepOf(platform);
  const prefix = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(prefix);
}

/** Joins an absolute root with a normalised relative path. */
export function joinAbsolutePath(root: string, relativePath: string, platform: PathPlatform): string {
  const rel = normalizeRelativePath(relativePath, platform);
  const base = normalizeAbsolutePath(root, platform);
  if (!rel) return base;
  const sep = sepOf(platform);
  const joined = (base.endsWith(sep) ? base : base + sep) + rel.split('/').join(sep);
  return normalizeAbsolutePath(joined, platform);
}

/** Relative path (forward slashes) of `candidate` inside `root`, or `null` when outside. */
export function relativeInside(root: string, candidate: string, platform: PathPlatform): string | null {
  if (!isPathInside(root, candidate, platform)) return null;
  const r = normalizeAbsolutePath(root, platform);
  const c = normalizeAbsolutePath(candidate, platform);
  const sep = sepOf(platform);
  if (foldCase(c, platform) === foldCase(r, platform)) return '';
  const rest = c.slice(r.endsWith(sep) ? r.length : r.length + 1);
  return rest.split(sep).join('/');
}

function parentAbsolute(p: string, platform: PathPlatform): string | null {
  const normalized = normalizeAbsolutePath(p, platform);
  const sep = sepOf(platform);
  const index = normalized.lastIndexOf(sep);
  if (platform === 'win32') {
    if (/^[A-Z]:\\$/.test(normalized)) return null;
    if (index <= 2) return normalized.slice(0, 3);
  } else if (normalized === '/') {
    return null;
  }
  return index <= 0 ? sep : normalized.slice(0, index);
}

// ---------------------------------------------------------------------------------------------
// Real confinement (symlinks resolved through the injected realpath)
// ---------------------------------------------------------------------------------------------

export interface ConfineOptions {
  platform: PathPlatform;
  /** `fs.promises.realpath` (or an equivalent). */
  realpath: (p: string) => Promise<string>;
  /**
   * When `false`, the target may not exist yet (a clone destination, a new worktree): the
   * nearest existing ancestor is resolved and must be inside the root. Default `true`.
   */
  mustExist?: boolean;
  /** Accept the root itself as a result (default `true`). */
  allowRoot?: boolean;
}

const isMissing = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

async function realpathOrNearest(
  target: string,
  options: ConfineOptions,
): Promise<{ real: string; missing: string[] }> {
  const missing: string[] = [];
  let current = normalizeAbsolutePath(target, options.platform);
  for (;;) {
    try {
      const real = normalizeAbsolutePath(await options.realpath(current), options.platform);
      return { real, missing: missing.toReversed() };
    } catch (error) {
      if (!isMissing(error)) throw new PathGuardError('PATH_INVALID', 'Chemin inaccessible.');
      const parent = parentAbsolute(current, options.platform);
      if (!parent || parent === current) throw new PathGuardError('PATH_NOT_FOUND', 'Chemin introuvable.');
      missing.push(baseName(current));
      current = parent;
    }
  }
}

async function confineTo(rootReal: string, target: string, options: ConfineOptions): Promise<string> {
  const { real, missing } = await realpathOrNearest(target, options);
  if (!isPathInside(rootReal, real, options.platform)) {
    throw new PathGuardError('PATH_OUTSIDE_ROOT', 'Le chemin sort du dossier autorisé.');
  }
  if (missing.length && (options.mustExist ?? true)) {
    throw new PathGuardError('PATH_NOT_FOUND', 'Chemin introuvable.');
  }
  const full = missing.length ? joinAbsolutePath(real, missing.join('/'), options.platform) : real;
  if (!(options.allowRoot ?? true) && foldCase(full, options.platform) === foldCase(rootReal, options.platform)) {
    throw new PathGuardError('PATH_INVALID', "Le dossier racine lui-même n'est pas accepté ici.");
  }
  return full;
}

/**
 * Resolves `relativePath` inside `root` and guarantees that the real (symlink-resolved) result
 * stays inside the real root. Returns the real absolute path (or, with `mustExist: false`, the real
 * nearest ancestor joined with the missing segments).
 */
export async function resolveConfinedPath(
  root: string,
  relativePath: string,
  options: ConfineOptions,
): Promise<string> {
  const rel = normalizeRelativePath(relativePath, options.platform);
  let rootReal: string;
  try {
    rootReal = normalizeAbsolutePath(await options.realpath(root), options.platform);
  } catch {
    throw new PathGuardError('PATH_NOT_FOUND', 'Dossier racine introuvable.');
  }
  const target = rel ? joinAbsolutePath(rootReal, rel, options.platform) : rootReal;
  return confineTo(rootReal, target, options);
}

/**
 * Confines an absolute path (e.g. a project path stored in the database) to at least one of the
 * given roots. Returns the real path.
 */
export async function confineAbsolutePath(
  candidate: string,
  roots: readonly string[],
  options: ConfineOptions,
): Promise<string> {
  if (!isAbsolutePath(candidate, options.platform)) {
    throw new PathGuardError('PATH_INVALID', 'Un chemin absolu est attendu.');
  }
  let lastError: PathGuardError | null = null;
  for (const root of roots) {
    let rootReal: string;
    try {
      rootReal = normalizeAbsolutePath(await options.realpath(root), options.platform);
    } catch {
      continue;
    }
    try {
      return await confineTo(rootReal, candidate, options);
    } catch (error) {
      if (isPathGuardError(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new PathGuardError('PATH_OUTSIDE_ROOT', 'Le chemin sort du dossier autorisé.');
}

// ---------------------------------------------------------------------------------------------
// Names (branches, worktrees, repositories)
// ---------------------------------------------------------------------------------------------

/** Branch name accepted by `git check-ref-format --branch` (conservative subset). */
export function isValidBranchName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false;
  if (name === 'HEAD' || name === '@') return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return false;
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Short worktree / folder name: `[a-z0-9][a-z0-9._-]*`, at most 64 characters. */
export function isValidWorktreeName(name: string): boolean {
  return (
    typeof name === 'string' &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) &&
    !name.endsWith('.lock') &&
    !name.endsWith('.') &&
    !name.includes('..')
  );
}

/** GitHub `owner/repo`. */
export function isValidRepoFullName(fullName: string): boolean {
  if (typeof fullName !== 'string') return false;
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(fullName);
  if (!match) return false;
  const repo = match[2]!;
  return repo !== '.' && repo !== '..';
}

/** ASCII slug: accents removed, lower case, `[a-z0-9-]`, trimmed to `maxLength`. */
export function slugify(input: string, maxLength = 48): string {
  const slug = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'x';
}

/** Worktree name derived from a branch: last segment, slugified (`feature/crm-core` → `crm-core`). */
export function worktreeNameFromBranch(branch: string): string {
  const last = branch.split('/').filter(Boolean).pop() ?? branch;
  return slugify(last, 64);
}
