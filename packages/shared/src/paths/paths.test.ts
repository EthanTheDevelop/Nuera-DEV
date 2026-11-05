import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  confineAbsolutePath,
  isPathInside,
  isValidBranchName,
  isValidRepoFullName,
  isValidWorktreeName,
  joinAbsolutePath,
  normalizeAbsolutePath,
  normalizeRelativePath,
  PathGuardError,
  relativeInside,
  resolveConfinedPath,
  slugify,
  worktreeNameFromBranch,
} from './index';

const platform = process.platform === 'win32' ? 'win32' : 'posix';
const opts = (mustExist = true) => ({ platform, realpath: (p: string) => realpath(p), mustExist }) as const;

describe('normalizeRelativePath', () => {
  it('normalises separators and dots', () => {
    expect(normalizeRelativePath('src/./modules//crm\\Board.tsx')).toBe('src/modules/crm/Board.tsx');
    expect(normalizeRelativePath('')).toBe('');
    expect(normalizeRelativePath('.')).toBe('');
  });

  it('rejects traversal, absolute paths and control characters', () => {
    expect(() => normalizeRelativePath('../etc/passwd')).toThrow(PathGuardError);
    expect(() => normalizeRelativePath('src/../../x')).toThrow(/remonter/);
    expect(() => normalizeRelativePath('/etc/passwd')).toThrow(/relatif/);
    expect(() => normalizeRelativePath('C:\\Windows')).toThrow(/relatif/);
    expect(() => normalizeRelativePath('\\\\server\\share')).toThrow(/relatif/);
    expect(() => normalizeRelativePath('a\u0000b')).toThrow(/contrôle/);
    expect(() => normalizeRelativePath('file.txt:stream', 'win32')).toThrow();
  });
});

describe('absolute paths', () => {
  it('normalises posix and win32 paths lexically', () => {
    expect(normalizeAbsolutePath('/srv/dev/../dev/./x/', 'posix')).toBe('/srv/dev/x');
    expect(normalizeAbsolutePath('c:/Users/x/../y', 'win32')).toBe('C:\\Users\\y');
    expect(normalizeAbsolutePath('\\\\?\\C:\\a\\b', 'win32')).toBe('C:\\a\\b');
  });

  it('tests containment without prefix confusion', () => {
    expect(isPathInside('/srv/dev', '/srv/dev/app', 'posix')).toBe(true);
    expect(isPathInside('/srv/dev', '/srv/dev', 'posix')).toBe(true);
    expect(isPathInside('/srv/dev', '/srv/dev', 'posix', { allowEqual: false })).toBe(false);
    expect(isPathInside('/srv/dev', '/srv/devil', 'posix')).toBe(false);
    expect(isPathInside('C:\\Data', 'c:\\data\\x', 'win32')).toBe(true);
    expect(relativeInside('/srv/dev', '/srv/dev/a/b', 'posix')).toBe('a/b');
    expect(relativeInside('/srv/dev', '/srv/other', 'posix')).toBeNull();
    expect(joinAbsolutePath('/srv/dev', 'a/b', 'posix')).toBe('/srv/dev/a/b');
  });
});

describe('real confinement (realpath)', () => {
  let root: string;
  let outside: string;
  let symlinkOk = true;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'nuera-paths-root-'));
    outside = mkdtempSync(path.join(os.tmpdir(), 'nuera-paths-out-'));
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    try {
      symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      symlinkOk = false;
    }
  }, 60_000);

  // File deletion can be very slow on the Windows dev machine (antivirus): generous timeout.
  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    } catch {
      // temporary folders: leftovers are harmless
    }
  }, 120_000);

  it('resolves an existing file inside the root', async () => {
    const resolved = await resolveConfinedPath(root, 'src/a.ts', opts());
    expect(resolved.toLowerCase()).toBe((await realpath(path.join(root, 'src', 'a.ts'))).toLowerCase());
  });

  it('rejects a symlink that escapes the root', async () => {
    if (!symlinkOk) return;
    await expect(resolveConfinedPath(root, 'escape/secret.txt', opts())).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ROOT' });
  });

  it('accepts a missing target only when allowed', async () => {
    await expect(resolveConfinedPath(root, 'new/dir', opts(true))).rejects.toMatchObject({ code: 'PATH_NOT_FOUND' });
    const resolved = await resolveConfinedPath(root, 'new/dir', opts(false));
    expect(resolved.replace(/\\/g, '/').endsWith('new/dir')).toBe(true);
  });

  it('confines absolute paths to the given roots', async () => {
    await expect(confineAbsolutePath(path.join(outside, 'secret.txt'), [root], opts())).rejects.toBeInstanceOf(PathGuardError);
    await expect(confineAbsolutePath(path.join(root, 'src', '..', '..', path.basename(outside)), [root], opts())).rejects.toBeInstanceOf(PathGuardError);
    expect(await confineAbsolutePath(path.join(root, 'src'), [root], opts())).toBeTruthy();
  });
});

describe('names', () => {
  it('validates branch names like git check-ref-format', () => {
    expect(isValidBranchName('feature/crm-core')).toBe(true);
    expect(isValidBranchName('main')).toBe(true);
    for (const bad of ['', '-x', 'a..b', 'a b', 'a~1', 'x.lock', 'a//b', '.hidden', 'HEAD', 'a@{1}', 'a:b', 'end/']) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });

  it('validates worktree and repository names', () => {
    expect(isValidWorktreeName('crm-core')).toBe(true);
    expect(isValidWorktreeName('Crm')).toBe(false);
    expect(isValidWorktreeName('../x')).toBe(false);
    expect(isValidRepoFullName('nuera-studio/roux-conseil')).toBe(true);
    expect(isValidRepoFullName('nuera-studio/../x')).toBe(false);
    expect(isValidRepoFullName('a/b/c')).toBe(false);
  });

  it('slugifies French text', () => {
    expect(slugify('Module CRM · pipeline')).toBe('module-crm-pipeline');
    expect(slugify('Écrire les tests')).toBe('ecrire-les-tests');
    expect(worktreeNameFromBranch('feature/crm-core')).toBe('crm-core');
  });
});
