import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { createDb } from '@nuera/db';
import { auditLog, projects, worktrees } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { E2E_BASE_URL, E2E_DATABASE_URL, expect, test } from './fixtures';

/**
 * Lot TERMINAL — the shared browser terminal (xterm.js) against REAL runner terminals.
 *
 * Needs a stack whose runner uses the TEST-ONLY fake CLI (NUERA_CLAUDE_BIN =
 * apps/runner/test/fixtures/fake-claude.mjs, NUERA_SESSION_BACKEND=pty), the web server pointing
 * at it (RUNNER_URL / RUNNER_TOKEN) and, for the shell test, NUERA_PROJECTS_ROOT = the runner's
 * projects root (the worktree folder is created there and seeded in the e2e database).
 *
 *   E2E_PORT=3202 E2E_DATABASE=nuera_terminal NUERA_PROJECTS_ROOT=… pnpm --filter @nuera/web e2e terminal
 */
test.describe.configure({ mode: 'serial' });

const isMobile = () => test.info().project.name === 'mobile';

function terminalIn(scope: Locator | Page): Locator {
  return scope.locator('[data-terminal-state]');
}

/** Visible text of the xterm screen (DOM renderer rows). */
function screenOf(terminal: Locator): Locator {
  return terminal.locator('.xterm-rows');
}

async function expectState(terminal: Locator, state: string, timeout = 90_000) {
  await expect(terminal).toHaveAttribute('data-terminal-state', state, { timeout });
}

async function focusTerminal(terminal: Locator) {
  await terminal.locator('.xterm-screen').click();
  await expect(terminal.locator('textarea.xterm-helper-textarea')).toBeFocused();
}

async function typeLine(page: Page, text: string) {
  await page.keyboard.type(text, { delay: 15 });
  await page.keyboard.press('Enter');
}

async function openKit(page: Page) {
  await page.goto('/kit/terminal');
  await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible({ timeout: 120_000 });
}

async function requireRunner(page: Page) {
  const response = await page.request.post('/api/terminals', { data: { kind: 'claude-status' }, headers: { origin: E2E_BASE_URL } });
  const body = (await response.json().catch(() => null)) as { terminal?: { id: string }; error?: { code: string; message: string } } | null;
  expect(response.status(), `runner de la pile de test : ${body?.error?.code ?? ''} ${body?.error?.message ?? ''}`).toBe(201);
  if (body?.terminal) await page.request.delete(`/api/terminals/${body.terminal.id}`, { headers: { origin: E2E_BASE_URL } });
}

test('la fenêtre « Ouvrir /status » relie le terminal au CLI : saisie, Échap, fin du processus, fermeture', async ({ page }) => {
  await openKit(page);
  await requireRunner(page);
  await page.getByRole('button', { name: 'Ouvrir /status', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Claude Code · /status' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Rien de ce qui s'affiche ou se tape ici n'est enregistré", { exact: false })).toBeVisible();
  const terminal = terminalIn(dialog);
  await expectState(terminal, 'live');
  await expect(terminal).toHaveAttribute('aria-label', 'Terminal Claude Code');
  await expect(screenOf(terminal)).toContainText('Fake Claude Code');

  await focusTerminal(terminal);
  await typeLine(page, '/status');
  // The fake CLI prints a status block (harness) or echoes the line (plain runner tests).
  await expect(screenOf(terminal)).toContainText(/Login method|Reçu : \/status/);
  await typeLine(page, 'bonjour');
  await expect(screenOf(terminal)).toContainText('Reçu : bonjour');

  if (isMobile()) {
    // Phone: the key bar sends Échap / Ctrl+C (no hardware keyboard).
    const keys = dialog.getByRole('toolbar', { name: 'Touches du terminal' });
    await expect(keys).toBeVisible();
    for (const name of ['Échap', 'Ctrl+C', 'Tabulation', 'Flèche gauche', 'Flèche haut', 'Flèche bas', 'Flèche droite']) {
      const box = await keys.getByRole('button', { name, exact: true }).boundingBox();
      expect(box?.height ?? 0, `${name} : cible tactile`).toBeGreaterThanOrEqual(44);
    }
    await keys.getByRole('button', { name: 'Échap', exact: true }).click();
    await expect(screenOf(terminal)).toContainText("Interrompu par l'utilisateur.");
    await keys.getByRole('button', { name: 'Ctrl+C', exact: true }).click();
    await expectState(terminal, 'exited');
    await expect(terminal).toContainText('Processus terminé · code 130');
  } else {
    // Desktop: Échap goes to the terminal, the window stays open.
    await page.keyboard.press('Escape');
    await expect(screenOf(terminal)).toContainText("Interrompu par l'utilisateur.");
    await expect(dialog).toBeVisible();
    await typeLine(page, '/exit');
    await expect(screenOf(terminal)).toContainText('Au revoir.');
    await expectState(terminal, 'exited');
    await expect(terminal).toContainText('Processus terminé · code 0');
  }

  const closed = page.waitForRequest((request) => request.method() === 'DELETE' && /\/api\/terminals\/[A-Za-z0-9_-]+$/.test(request.url()));
  await dialog.getByRole('button', { name: isMobile() ? 'Fermer le terminal' : 'Fermer', exact: true }).click();
  await closed;
  await expect(dialog).toBeHidden();
});

test("le terminal intégré se reconnecte après une coupure et repart d'un instantané frais", async ({ page }) => {
  await openKit(page);
  await page.getByRole('button', { name: 'Ouvrir /status ici' }).click();
  const terminal = page.getByRole('group', { name: 'Terminal Claude Code' });
  await expectState(terminal, 'live');
  await focusTerminal(terminal);
  await typeLine(page, 'avant la coupure');
  await expect(screenOf(terminal)).toContainText('Reçu : avant la coupure');

  await page.context().setOffline(true);
  await expectState(terminal, 'reconnecting', 60_000);
  await page.context().setOffline(false);
  await expectState(terminal, 'live', 60_000);
  // The fresh snapshot (screen + scrollback) brought the previous exchange back.
  await expect(screenOf(terminal)).toContainText('Reçu : avant la coupure');
  await focusTerminal(terminal);
  await typeLine(page, 'après');
  await expect(screenOf(terminal)).toContainText('Reçu : après');

  await page.getByRole('button', { name: "Lire l'état (GET)" }).click();
  await expect(page.getByTestId('kit-inline-info')).toContainText('claude-status');
  await expect(page.getByTestId('kit-inline-info')).toContainText('vivant');

  const closed = page.waitForRequest((request) => request.method() === 'DELETE' && request.url().includes('/api/terminals/'));
  await page.getByRole('button', { name: 'Fermer ce terminal' }).click();
  await closed;
  await expect(page.getByRole('button', { name: 'Ouvrir /status ici' })).toBeVisible();
});

test("un shell s'ouvre dans un worktree actif et exécute ce qu'on y tape", async ({ page }) => {
  const projectsRoot = process.env.NUERA_PROJECTS_ROOT;
  test.skip(!projectsRoot, 'NUERA_PROJECTS_ROOT (racine des projets du runner de la pile) est nécessaire pour créer le worktree de test.');
  const worktreeName = 'terminal-e2e';
  const folder = path.resolve(projectsRoot!, worktreeName);
  mkdirSync(folder, { recursive: true });
  const db = createDb(E2E_DATABASE_URL, { max: 1, applicationName: 'nuera-e2e-terminal' });
  try {
    const existing = await db.select().from(worktrees).where(eq(worktrees.name, worktreeName)).limit(1);
    if (existing.length === 0) {
      const [project] = await db
        .insert(projects)
        .values({
          slug: 'terminal-e2e',
          name: 'Terminal E2E',
          githubFullName: 'nuera-e2e/terminal-e2e',
          cloneUrl: 'https://github.com/nuera-e2e/terminal-e2e.git',
          path: folder,
          status: 'ready',
        })
        .returning();
      await db.insert(worktrees).values({ projectId: project!.id, name: worktreeName, branch: 'main', path: folder, isPrimary: true, status: 'active' });
    }
  } finally {
    await db.$client.end({ timeout: 5 });
  }

  await openKit(page);
  await page.getByRole('button', { name: `Shell · ${worktreeName}` }).click();
  const dialog = page.getByRole('dialog', { name: `Terminal · ${worktreeName}` });
  const terminal = terminalIn(dialog);
  await expectState(terminal, 'live');
  await focusTerminal(terminal);
  // PowerShell on the Windows dev machine, bash/zsh on Linux: both expand $((6*7)) to 42, so only
  // the command's OUTPUT contains « nuera-terminal-42ok » (the echoed command line does not).
  await page.waitForTimeout(1_500);
  await typeLine(page, 'echo nuera-terminal-$((6*7))ok');
  await expect(screenOf(terminal)).toContainText('nuera-terminal-42ok', { timeout: 60_000 });

  const audit = createDb(E2E_DATABASE_URL, { max: 1, applicationName: 'nuera-e2e-terminal' });
  try {
    const rows = await audit.select().from(auditLog).where(eq(auditLog.action, 'terminal.open'));
    expect(rows.map((row) => row.summary)).toContain(`terminal ouvert dans le worktree « ${worktreeName} » · Terminal E2E`);
  } finally {
    await audit.$client.end({ timeout: 5 });
  }

  await dialog.getByRole('button', { name: isMobile() ? 'Fermer le terminal' : 'Fermer', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('POST /api/terminals : session, Origin et types de terminaux', async ({ page, browser }) => {
  await openKit(page);
  const sameOrigin = { origin: E2E_BASE_URL };
  const mcp = await page.request.post('/api/terminals', { data: { kind: 'mcp-login', serverName: 'figma' }, headers: sameOrigin });
  expect(mcp.status()).toBe(422);
  const bad = await page.request.post('/api/terminals', { data: { kind: 'shell', worktreeId: 'pas-un-uuid' }, headers: sameOrigin });
  expect(bad.status()).toBe(422);
  const unknown = await page.request.post('/api/terminals', { data: { kind: 'shell', worktreeId: '00000000-0000-4000-8000-000000000000' }, headers: sameOrigin });
  expect(unknown.status()).toBe(404);
  const noOrigin = await page.request.post('/api/terminals', { data: { kind: 'claude-status' } });
  expect(noOrigin.status()).toBe(403);
  const foreign = await page.request.post('/api/terminals', { data: { kind: 'claude-status' }, headers: { origin: 'https://evil.example' } });
  expect(foreign.status()).toBe(403);

  const anonymous = await browser.newContext({ baseURL: E2E_BASE_URL, storageState: { cookies: [], origins: [] } });
  try {
    const response = await anonymous.request.post('/api/terminals', { data: { kind: 'claude-status' }, headers: sameOrigin });
    expect(response.status()).toBe(401);
    const stream = await anonymous.request.get('/api/stream/terminals/abcdefgh12345');
    expect(stream.status()).toBe(401);
  } finally {
    await anonymous.close();
  }

  const created = await page.request.post('/api/terminals', { data: { kind: 'claude-status', cols: 90, rows: 24 }, headers: sameOrigin });
  expect(created.status()).toBe(201);
  const { terminal } = (await created.json()) as { terminal: { id: string; kind: string; private: boolean; cols: number } };
  expect(terminal).toMatchObject({ kind: 'claude-status', private: true, cols: 90 });
  const info = await page.request.get(`/api/terminals/${terminal.id}`);
  expect(info.status()).toBe(200);
  expect(((await info.json()) as { terminal: { id: string } }).terminal.id).toBe(terminal.id);
  expect((await page.request.delete(`/api/terminals/${terminal.id}`, { headers: sameOrigin })).status()).toBe(204);
  expect((await page.request.delete(`/api/terminals/${terminal.id}`, { headers: sameOrigin })).status()).toBe(204);
  expect((await page.request.get(`/api/terminals/${terminal.id}`)).status()).toBe(404);
});
