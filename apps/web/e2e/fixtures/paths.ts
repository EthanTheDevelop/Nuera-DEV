/**
 * TEST-ONLY — portable comparisons for the specs (Windows and Linux):
 *
 *   expect(samePath(worktree.path, porcelainPath)).toBe(true);   // `P:\…` vs `P:/…`, case on Windows
 *   await expect(toast).toHaveText(`Clé d'accès enregistrée : ${await deviceLabelOf(page)}`);
 */
import path from 'node:path';
import type { Page } from '@playwright/test';
import { describeDevice } from '../../src/server/auth/device';

/** Absolute path with forward slashes, without trailing slash, lower-cased on Windows (case-insensitive). */
export function normalizePath(value: string, platform: NodeJS.Platform = process.platform): string {
  const isWindows = platform === 'win32' || /^[A-Za-z]:[\\/]/.test(value);
  const resolved = isWindows ? path.win32.resolve(value) : path.posix.resolve(value);
  const forward = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindows ? forward.toLowerCase() : forward;
}

/** True when two paths name the same location (git prints `P:/…` where Node prints `P:\…`). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalizePath(a, platform) === normalizePath(b, platform);
}

/** Device label the web derives from this browser's User-Agent (« PC Windows · Chrome », « iPhone · Safari »…). */
export async function deviceLabelOf(page: Page): Promise<string> {
  return describeDevice(await page.evaluate(() => navigator.userAgent)).label;
}
