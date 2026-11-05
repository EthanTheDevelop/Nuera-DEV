/**
 * TEST-ONLY — Chromium used by the stack launcher and the Playwright projects.
 *
 * Playwright looks for the browser build it was released with (`chromium_headless_shell-<rev>`).
 * Machines where the browsers were preinstalled for another revision (and `playwright install` is
 * not allowed) still work: the newest installed build is used instead.
 *
 *   E2E_CHROMIUM_PATH=/path/to/chrome   forces an executable
 */
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

function browsersRoot(): string {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (configured && configured !== '0') return configured;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

const CANDIDATES: Array<{ prefix: string; files: string[] }> = [
  {
    prefix: 'chromium_headless_shell-',
    files: [
      'chrome-headless-shell-linux64/chrome-headless-shell',
      'chrome-headless-shell-win64/chrome-headless-shell.exe',
      'chrome-headless-shell-mac-arm64/chrome-headless-shell',
      'chrome-headless-shell-mac-x64/chrome-headless-shell',
    ],
  },
  { prefix: 'chromium-', files: ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win64/chrome.exe', 'chrome-win/chrome.exe'] },
];

let cached: string | undefined | null = null;

/** `undefined` = Playwright's own build is installed (default behaviour). */
export function chromiumExecutable(): string | undefined {
  if (cached !== null) return cached;
  const forced = process.env.E2E_CHROMIUM_PATH?.trim();
  if (forced) return (cached = forced);
  try {
    if (existsSync(chromium.executablePath())) return (cached = undefined);
  } catch {
    // unknown platform: scan below
  }
  const root = browsersRoot();
  if (existsSync(root)) {
    const entries = readdirSync(root);
    for (const candidate of CANDIDATES) {
      const dirs = entries
        .filter((entry) => entry.startsWith(candidate.prefix) && /^\d+$/.test(entry.slice(candidate.prefix.length)))
        .sort((a, b) => Number(b.slice(candidate.prefix.length)) - Number(a.slice(candidate.prefix.length)));
      for (const dir of dirs) {
        for (const file of candidate.files) {
          const full = path.join(root, dir, file);
          if (existsSync(full)) return (cached = full);
        }
      }
    }
  }
  return (cached = undefined);
}

/** `launchOptions` for Playwright (`use.launchOptions`, `chromium.launch()`). */
export function chromiumLaunchOptions(): { executablePath?: string } {
  const executablePath = chromiumExecutable();
  return executablePath ? { executablePath } : {};
}
