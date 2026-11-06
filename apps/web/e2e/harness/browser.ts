/**
 * TEST-ONLY — browser side of the stack launcher: owner setup, invitation acceptance and sign-in
 * through the real pages (same helpers as the e2e fixtures), signed-in request contexts per account,
 * page warm-up, screenshots.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, devices, request as playwrightRequest, type APIRequestContext, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { acceptInvitation, completeOwnerSetup, ensureBackupCodes, readOwnerState, signIn, type AccountState, type OwnerState } from '../fixtures/owner';
import { chromiumLaunchOptions } from './chromium';
import type { StackKey } from './config';
import { accountOf, type StackState } from './state';

export const DESKTOP_VIEWPORT = { width: 1440, height: 1000 };
export const MOBILE_VIEWPORT = { width: 390, height: 844 };

export function contextOptions(baseURL: string, mobile = false): BrowserContextOptions {
  return mobile
    ? {
        baseURL,
        viewport: MOBILE_VIEWPORT,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: devices['iPhone 13']!.userAgent,
        locale: 'fr-FR',
        timezoneId: 'Europe/Paris',
      }
    : { baseURL, viewport: DESKTOP_VIEWPORT, locale: 'fr-FR', timezoneId: 'Europe/Paris' };
}

export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    return await fn(browser);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function withPage<T>(state: StackState, fn: (page: Page, save: (file: string) => Promise<void>) => Promise<T>): Promise<T> {
  return withBrowser(async (browser) => {
    const context = await browser.newContext(contextOptions(state.urls.web));
    context.setDefaultNavigationTimeout(300_000);
    context.setDefaultTimeout(120_000);
    const page = await context.newPage();
    try {
      return await fn(page, async (file) => {
        mkdirSync(path.dirname(file), { recursive: true });
        await context.storageState({ path: file });
      });
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}

/** First-run setup through /configuration (token, account, TOTP, backup codes): account `a`. */
export async function createOwner(state: StackState): Promise<OwnerState> {
  const account = accountOf(state, 'a');
  return withPage(state, async (page, save) => {
    const owner = await completeOwnerSetup(page, { name: account.name, email: account.email, password: account.password }, { setupToken: state.secrets.setupToken, stateFile: account.stateFile });
    await save(account.storageState);
    return owner;
  });
}

/** Account `key` accepts its invitation in a fresh browser (real /invitation/<jeton> page + mandatory 2FA). */
export async function acceptInvitationInBrowser(state: StackState, key: StackKey, inviteUrl: string): Promise<AccountState> {
  const account = accountOf(state, key);
  return withPage(state, async (page, save) => {
    const created = await acceptInvitation(page, inviteUrl, { name: account.name, email: account.email, password: account.password }, { stateFile: account.stateFile });
    await save(account.storageState);
    return created;
  });
}

/** Password + TOTP through /connexion for account `key`; writes its storage state (or `out`). */
export async function signInToFile(state: StackState, key: StackKey = 'a', out?: string): Promise<string> {
  const account = accountOf(state, key);
  const stored = readOwnerState(account.stateFile);
  if (!stored) throw new Error(`Compte « ${key} » inconnu pour la pile ${state.name} (${path.basename(account.stateFile)} absent) : relancez \`up\`.`);
  const file = out ?? account.storageState;
  await withPage(state, async (page, save) => {
    await signIn(page, stored, { stateFile: account.stateFile });
    await save(file);
  });
  return file;
}

async function storageIsValid(state: StackState, key: StackKey): Promise<boolean> {
  const file = accountOf(state, key).storageState;
  if (!existsSync(file)) return false;
  const request = await playwrightRequest.newContext({ baseURL: state.urls.web, storageState: file });
  try {
    const response = await request.get('/api/notifications/counts', { timeout: 300_000 });
    return response.status() === 200;
  } catch {
    return false;
  } finally {
    await request.dispose();
  }
}

/** Signed-in API context of account `key` (cookies of its storage state, re-signing in when it expired). */
export async function signedInRequest(state: StackState, key: StackKey = 'a'): Promise<APIRequestContext> {
  if (!(await storageIsValid(state, key))) await signInToFile(state, key);
  return playwrightRequest.newContext({ baseURL: state.urls.web, storageState: accountOf(state, key).storageState, timeout: 300_000 });
}

/** Keeps at least `min` unused backup codes in the account's file (the backup-code journeys consume one per run). */
export async function topUpBackupCodes(state: StackState, key: StackKey = 'a', min = 3): Promise<number> {
  const file = accountOf(state, key).stateFile;
  const stored = readOwnerState(file);
  if (!stored || stored.backupCodes.length >= min) return stored?.backupCodes.length ?? 0;
  const request = await signedInRequest(state, key);
  try {
    return await ensureBackupCodes(request, state.urls.web, { stateFile: file, min });
  } finally {
    await request.dispose();
  }
}

/** Requests each path once so that `next dev` compiles it before the first test (cold compiles take minutes). */
export async function warmPages(state: StackState, paths: string[], log: (line: string) => void, signedIn: false | StackKey = 'a'): Promise<void> {
  const request = signedIn ? await signedInRequest(state, signedIn) : await playwrightRequest.newContext({ baseURL: state.urls.web });
  try {
    for (const pathname of paths) {
      const started = Date.now();
      try {
        const response = await request.get(pathname, { maxRedirects: 0, timeout: 600_000 });
        log(`  préchauffage ${pathname}${signedIn && signedIn !== 'a' ? ` (compte ${signedIn})` : ''} → ${response.status()} (${Math.round((Date.now() - started) / 1000)} s)`);
      } catch (error) {
        log(`  préchauffage ${pathname} : ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      }
    }
  } finally {
    await request.dispose();
  }
}

/**
 * Hides the `next dev` indicator (« N » button of `<nextjs-portal>`, bottom left): it covers the
 * user card of the sidebar on desktop and the first tab of the phone tab bar, which would distort
 * every comparison with the Figma exports. Dev-only overlay, absent from production.
 */
export async function hideNextDevIndicator(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

export interface ShotOptions {
  /** Path of the page (`/`, `/projets`…). */
  path: string;
  out: string;
  mobile?: boolean;
  /** Whole page (scroll height) instead of the viewport. */
  full?: boolean;
  /** Extra wait after the page is loaded and hydrated (ms, default 2500). */
  waitMs?: number;
  /** Waits for this selector before capturing. */
  selector?: string;
  /** Colour scheme of the browser. */
  dark?: boolean;
  /** Account signed in (default `a`). */
  account?: StackKey;
}

/**
 * Screenshot of a signed-in page. Long pages with live clocks never become « stable » for
 * Playwright's fullPage capture: `full` scrolls, then captures with a clip (CLAUDE.md).
 */
export async function screenshot(state: StackState, options: ShotOptions): Promise<string> {
  const key = options.account ?? 'a';
  if (!(await storageIsValid(state, key))) await signInToFile(state, key);
  mkdirSync(path.dirname(options.out), { recursive: true });
  await withBrowser(async (browser) => {
    const context = await browser.newContext({ ...contextOptions(state.urls.web, options.mobile), storageState: accountOf(state, key).storageState, colorScheme: options.dark ? 'dark' : 'light' });
    context.setDefaultNavigationTimeout(300_000);
    const page = await context.newPage();
    await page.goto(options.path, { waitUntil: 'load' });
    if (new URL(page.url()).pathname.startsWith('/connexion')) throw new Error('Session expirée : relancez `login`.');
    await page.waitForFunction(() => document.readyState === 'complete', undefined, { timeout: 120_000 });
    if (options.selector) await page.locator(options.selector).first().waitFor({ state: 'visible', timeout: 120_000 });
    await page.waitForTimeout(options.waitMs ?? 2500);
    await hideNextDevIndicator(page);
    if (options.full) {
      const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
      await page.evaluate((h) => window.scrollTo(0, h), height);
      await page.waitForTimeout(300);
      await page.evaluate(() => window.scrollTo(0, 0));
      const viewport = page.viewportSize()!;
      await page.screenshot({ path: options.out, clip: { x: 0, y: 0, width: viewport.width, height }, fullPage: true, animations: 'disabled', caret: 'hide', timeout: 120_000 });
    } else {
      await page.screenshot({ path: options.out, animations: 'disabled', caret: 'hide', timeout: 120_000 });
    }
    await context.close();
  });
  return options.out;
}

/**
 * True when a page of the web keeps reloading by itself. Seen once with `next dev` 16.4 restarted
 * on a warm `.next-<pile>` cache: every HMR connection got `turbopack-message … restart` then
 * `reloadPage: HMR hash mismatch`, so forms were reset while being filled. A restart cured it.
 */
export async function reloadLoopDetected(state: StackState, pathname = '/connexion', windowMs = 5000): Promise<boolean> {
  return withBrowser(async (browser) => {
    const context = await browser.newContext(contextOptions(state.urls.web));
    context.setDefaultNavigationTimeout(300_000);
    const page = await context.newPage();
    let navigations = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });
    await page.goto(pathname, { waitUntil: 'load' });
    await page.waitForTimeout(windowMs);
    await context.close();
    // One navigation for the goto (plus, at most, one redirect).
    return navigations > 2;
  });
}
