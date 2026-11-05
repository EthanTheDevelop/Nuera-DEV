import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export interface CommandSpec {
  file: string;
  /** Arguments placed before the caller's own arguments (e.g. the script of a JS CLI). */
  prefix: string[];
}

/** `which` without a shell (PATH + PATHEXT on Windows). */
export function whichSync(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (command.includes('/') || command.includes('\\')) return existsSync(command) ? path.resolve(command) : null;
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of process.platform === 'win32' ? ['', ...exts] : exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      const candidateUpper = path.join(dir, command + ext);
      for (const c of [candidate, candidateUpper]) {
        try {
          if (!statSync(c).isFile()) continue;
          if (process.platform !== 'win32') accessSync(c, constants.X_OK);
          else if (!ext) continue; // Windows: an extension is required to execute
          return c;
        } catch {
          // keep looking
        }
      }
    }
  }
  return null;
}

/**
 * Official Claude Code CLI: NUERA_CLAUDE_BIN when set, else `claude` on PATH. A `.mjs`/`.js`
 * path is executed with this Node binary (test fake CLI only).
 */
export function resolveClaudeCommand(configured: string | null): CommandSpec | null {
  const target = configured ?? 'claude';
  if (/\.(c|m)?js$/i.test(target)) {
    const script = path.resolve(target);
    return existsSync(script) ? { file: process.execPath, prefix: [script] } : null;
  }
  const resolved = whichSync(target);
  if (!resolved) return null;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    // npm shims cannot be spawned without a shell; the native installer ships claude.exe.
    return null;
  }
  return { file: resolved, prefix: [] };
}
