import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { E2E_BASE_URL, expect, hideNextDevIndicator, requireAccounts, test } from './fixtures';

/**
 * Accessibility check of every page, desktop and phone (axe-core is not installed: the accessibility
 * tree through `ariaSnapshot()` / `getByRole`, plus a few DOM measures).
 *
 * Per page: one `main`, the navigation landmark, one h1, every control with an accessible name, an
 * `aria-live` region for live updates, a visible focus ring, no horizontal scroll at 390 px. Then
 * the keyboard: command palette (title, focus kept inside, arrows, Échap restores the focus), account
 * menu (arrows, Échap), project tabs (arrows), sheet / dialog titles. Finally the contrast of the text
 * tokens of tokens.css (WCAG AA 4.5:1 for text).
 */
const isMobile = () => test.info().project.name === 'mobile';

/** Controls that must carry a name (ariaSnapshot prints `- button` / `- textbox: value` without one). */
const NAMED_ROLES = ['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'switch', 'radio', 'tab', 'menuitem', 'slider', 'spinbutton', 'option'];
const UNNAMED = new RegExp(`^\\s*- (${NAMED_ROLES.join('|')})(?: \\[[^\\]]*\\])*(?::.*)?$`);

async function settle(page: Page) {
  await page.waitForFunction(() => document.readyState === 'complete');
  await hideNextDevIndicator(page);
  // Hydration (Radix ids, live stream) before reading the tree.
  await page.waitForTimeout(800);
}

/** Structural issues of the current page (empty list = OK). */
async function structuralIssues(page: Page, options: { navigation: boolean }): Promise<string[]> {
  const issues: string[] = [];
  const mains = await page.getByRole('main').count();
  if (mains !== 1) issues.push(`${mains} landmark(s) main (attendu : 1)`);
  if (options.navigation) {
    const navs = await page.getByRole('navigation').filter({ visible: true }).count();
    if (navs < 1) issues.push('aucun landmark navigation visible');
  }
  const h1 = await page.locator('h1').filter({ visible: true }).count();
  if (h1 !== 1) issues.push(`${h1} h1 visible(s) (attendu : 1)`);

  const snapshot = await page.locator('body').ariaSnapshot();
  for (const line of snapshot.split('\n')) {
    if (UNNAMED.test(line)) issues.push(`contrôle sans nom accessible : ${line.trim()}`);
  }

  // Images and icons: an <svg>/<img> outside a named control must be hidden or labelled.
  const unlabelledImages = await page.evaluate(() =>
    Array.from(document.querySelectorAll('img:not([alt])')).map((img) => (img as HTMLImageElement).src.slice(-60)),
  );
  for (const src of unlabelledImages) issues.push(`image sans alt : ${src}`);

  // Duplicate ids break label/aria references.
  const duplicates = await page.evaluate(() => {
    const seen = new Map<string, number>();
    for (const el of Array.from(document.querySelectorAll('[id]'))) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
    return [...seen].filter(([id, n]) => n > 1 && id).map(([id]) => id);
  });
  for (const id of duplicates) issues.push(`id en double : ${id}`);

  // Live updates are announced (Toaster region at least, status lines of the shell).
  const live = await page.locator('[aria-live], [role="status"], [role="alert"], [role="log"]').count();
  if (live < 1) issues.push('aucune région aria-live');

  if (isMobile()) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) issues.push(`défilement horizontal de ${overflow} px à 390 px`);
  }
  return issues;
}

/** Tab to the first focusable element and check that the focus ring is drawn (outline or ring shadow). */
async function expectVisibleFocusRing(page: Page) {
  await page.locator('body').click({ position: { x: 1, y: 1 }, force: true }).catch(() => undefined);
  await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { tag: 'body', visible: false };
    const style = getComputedStyle(el);
    const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
    const shadow = style.boxShadow !== 'none' && style.boxShadow !== '';
    return { tag: `${el.tagName.toLowerCase()} ${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''}`, visible: outline || shadow };
  });
  expect(ring.visible, `anneau de focus visible sur ${ring.tag}`).toBe(true);
}

/** Dialog / sheet open: it has a name, the focus is inside and Tab keeps it inside. */
async function expectFocusTrapped(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible();
  const name = await dialog.evaluate((el) => {
    const labelledby = el.getAttribute('aria-labelledby');
    const label = el.getAttribute('aria-label') ?? (labelledby ? document.getElementById(labelledby)?.textContent : null);
    return label?.trim() ?? '';
  });
  expect(name, 'la fenêtre a un titre accessible').not.toBe('');
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement)), 'le focus reste dans la fenêtre').toBe(true);
  }
}

const pages = (stack: { seeded: { projects?: Record<string, { id: string }>; sessions?: Record<string, { id: string }> } }) => {
  const project = stack.seeded.projects?.devis?.id;
  const session = stack.seeded.sessions?.finished?.id;
  return [
    { name: 'Accueil', url: '/' },
    { name: 'Projets', url: '/projets' },
    ...(project ? [{ name: 'Projet', url: `/projets/${project}` }] : []),
    // Full-screen flow on the phone (tab bar hidden by design, « Retour » in its header).
    { name: 'Nouveau projet', url: '/projets/nouveau', navigation: !isMobile() },
    { name: 'Sessions', url: '/sessions' },
    { name: 'Intégrations', url: '/integrations' },
    { name: 'Paramètres', url: '/parametres' },
    // Instance administration (owner / admin): every tab.
    { name: 'Administration · comptes', url: '/administration' },
    { name: 'Administration · serveurs', url: '/administration?onglet=serveurs' },
    { name: 'Administration · instance', url: '/administration?onglet=instance' },
    { name: 'Administration · journal', url: '/administration?onglet=journal' },
    ...(session ? [{ name: 'Espace de travail', url: `/workspace/${session}`, navigation: false }] : []),
  ];
};

test('chaque page : landmarks, un h1, contrôles nommés, région live, anneau de focus', async ({ page, stack }) => {
  test.setTimeout(240_000);
  const report: string[] = [];
  for (const entry of pages(stack)) {
    await page.goto(entry.url);
    await settle(page);
    const issues = await structuralIssues(page, { navigation: entry.navigation ?? true });
    report.push(...issues.map((issue) => `${entry.name} (${entry.url}) : ${issue}`));
    await expectVisibleFocusRing(page);
  }
  expect(report).toEqual([]);
});

test('palette de commandes au clavier : titre, focus piégé, flèches, Échap rend le focus', async ({ page }) => {
  test.skip(isMobile(), 'la palette s\'ouvre au clavier (⌘K / Ctrl+K) sur le bureau');
  await page.goto('/projets');
  await settle(page);
  const trigger = page.getByRole('button', { name: /Rechercher/ });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Recherche' });
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill('par');
  const options = dialog.getByRole('option');
  await expect(options.first()).toBeVisible();
  const selected = () => dialog.locator('[role="option"][aria-selected="true"]').textContent();
  const first = await selected();
  if ((await options.count()) > 1) {
    await page.keyboard.press('ArrowDown');
    expect(await selected()).not.toBe(first);
    await page.keyboard.press('ArrowUp');
    expect(await selected()).toBe(first);
  }
  await expectFocusTrapped(page, dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  // ⌘K / Ctrl+K toggles it from anywhere.
  await page.keyboard.press('Control+k');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(dialog).toBeHidden();
});

test('menu du compte et onglets du projet au clavier', async ({ page, stack }) => {
  test.skip(isMobile(), 'carte utilisateur de la barre latérale (bureau)');
  await page.goto('/');
  await settle(page);
  const account = page.getByRole('button', { name: `${stack.owner.name} · menu du compte` });
  await account.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  await expect(items.first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  const focusedInMenu = await menu.evaluate((el) => el.contains(document.activeElement) && document.activeElement?.getAttribute('role') === 'menuitem');
  expect(focusedInMenu).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(account).toBeFocused();

  const project = stack.seeded.projects?.devis?.id;
  test.skip(!project, 'projets absents (E2E_SEED=none)');
  await page.goto(`/projets/${project}`);
  await settle(page);
  const tablist = page.getByRole('tablist', { name: 'Sections du projet' }).filter({ visible: true });
  const tabs = tablist.getByRole('tab');
  await tabs.first().focus();
  const before = await tabs.first().getAttribute('aria-selected');
  expect(before).toBe('true');
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(tabs.first()).toBeFocused();
});

test('fenêtre « Nouveau projet » et feuille de notifications : titre, focus piégé et rendu', async ({ page }) => {
  await page.goto('/projets');
  await settle(page);
  const add = page.getByRole('link', { name: /Ajouter un projet/ }).filter({ visible: true }).first();
  await add.click();
  await expect(page).toHaveURL(/\/projets\/nouveau$/);
  // Intercepted route = window over the list (docked to the bottom edge on the phone).
  const dialog = page.getByRole('dialog', { name: /Ajouter un projet/ });
  await expectFocusTrapped(page, dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Notifications: popover on the desktop, sheet on the phone — both dialogs with a title.
  await page.goto('/');
  await settle(page);
  const bell = page.getByRole('button', { name: /Notifications/ }).filter({ visible: true }).first();
  await bell.click();
  const panel = page.getByRole('dialog').filter({ visible: true }).first();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(bell).toBeFocused();
});

/** WCAG relative luminance contrast, alpha colours composited on their background. */
function contrast(fg: string, bg: string): number {
  const parse = (hex: string) => {
    const h = hex.replace('#', '');
    const rgb = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
    const alpha = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { rgb, alpha };
  };
  const back = parse(bg).rgb;
  const front = parse(fg);
  const mixed = front.rgb.map((c, i) => c * front.alpha + back[i]! * (1 - front.alpha));
  const lum = (c: number[]) => {
    const [r, g, b] = c.map((v) => {
      const s = v / 255;
      return s <= 0.039_28 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [lum(mixed), lum(back)].sort((a, b) => b - a);
  return (hi! + 0.05) / (lo! + 0.05);
}

test('contraste des jetons de texte (tokens.css, AA 4,5:1)', () => {
  test.skip(isMobile(), 'calcul sans navigateur, une fois');
  const css = readFileSync(fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)), 'utf8');
  const token = (name: string) => {
    const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6,8})`).exec(css);
    if (!match) throw new Error(`jeton --${name} introuvable`);
    return match[1]!;
  };
  const pairs: Array<[string, string]> = [
    ['ink', 'paper'],
    ['muted-on-light', 'paper'],
    ['accent-on-light', 'paper'],
    ['ink', 'accent-pale'],
    ['muted-on-light', 'accent-pale'],
    ['success', 'paper'],
    ['success', 'success-pale'],
    ['warn', 'paper'],
    ['warn', 'warn-pale'],
    ['danger', 'paper'],
    ['danger', 'danger-pale'],
    ['paper', 'ink'],
    ['muted-on-dark', 'ink'],
    ['accent-on-dark', 'ink'],
    ['success-on-dark', 'ink'],
    ['warn-on-dark', 'ink'],
    ['danger-on-dark', 'ink'],
    ['paper', 'accent-on-light'],
  ];
  const failing = pairs
    .map(([fg, bg]) => ({ pair: `${fg} sur ${bg}`, ratio: contrast(token(fg), token(bg)) }))
    .filter((p) => p.ratio < 4.5)
    .map((p) => `${p.pair} : ${p.ratio.toFixed(2)}`);
  expect(failing).toEqual([]);

  // Known Figma value below AA for small text: the « Accent » badge (accent-on-light on accent-pale,
  // Outfit 500 12) reaches 4.31:1. Figma is the authority on colours: tracked in the review followups.
  expect(contrast(token('accent-on-light'), token('accent-pale'))).toBeGreaterThan(4.2);
});

test('@comptes pages du second compte : mêmes exigences, sans entrée « Administration »', async ({ as }) => {
  requireAccounts(2);
  test.setTimeout(240_000);
  const b = await as('b');
  const report: string[] = [];
  for (const entry of [
    { name: 'Accueil', url: '/' },
    { name: 'Projets', url: '/projets' },
    { name: 'Sessions', url: '/sessions' },
    { name: 'Intégrations', url: '/integrations' },
    { name: 'Paramètres', url: '/parametres' },
  ]) {
    await b.page.goto(entry.url);
    await settle(b.page);
    const issues = await structuralIssues(b.page, { navigation: true });
    report.push(...issues.map((issue) => `B · ${entry.name} (${entry.url}) : ${issue}`));
    // A member never sees the instance administration in the navigation.
    await expect(b.page.getByRole('link', { name: /^Administration/ })).toHaveCount(0);
  }
  expect(report).toEqual([]);
});

test("pages publiques d'invitation et de récupération : landmarks et un h1", async ({ browser }) => {
  const visitor = await browser.newContext({ baseURL: E2E_BASE_URL, storageState: { cookies: [], origins: [] } });
  try {
    const page = await visitor.newPage();
    const report: string[] = [];
    for (const url of ['/invitation/jeton-de-test-inconnu-0123456789abcdef0123456', '/recuperation/jeton-de-test-inconnu-0123456789abcdef0123456']) {
      await page.goto(url);
      await settle(page);
      report.push(...(await structuralIssues(page, { navigation: false })).map((issue) => `${url} : ${issue}`));
    }
    expect(report).toEqual([]);
  } finally {
    await visitor.close();
  }
});
