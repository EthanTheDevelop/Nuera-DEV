import type { Locator, Page } from '@playwright/test';
import { E2E_BASE_URL, expect, test, type StackFixtures } from './fixtures';

/**
 * Lot SESSIONS — /sessions (D06 / M06), the « Nouvelle session » dialog and the life-cycle routes,
 * against the stack's REAL runner (pty backend, TEST-ONLY fake CLI) and seeded sessions.
 *
 *   E2E_STACK=sessions pnpm --filter @nuera/web e2e sessions.spec.ts
 *
 * Every session a test creates is stopped / archived at the end (the seeds keep 3 CLIs alive).
 */
test.describe.configure({ mode: 'serial' });

const isMobile = () => test.info().project.name === 'mobile';
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

function visible(page: Page, selector: string): Locator {
  return page.locator(`${selector}:visible`);
}

async function openSessions(page: Page, search = '') {
  await page.goto(`/sessions${search}`);
  await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toBeVisible({ timeout: 120_000 });
}

async function apiCreate(page: Page, projectId: string, title: string, extra: Record<string, unknown> = {}) {
  const response = await page.request.post('/api/sessions', {
    data: { projectId, title, branch: { mode: 'new', branch: `test/${unique()}` }, ...extra },
    headers: { origin: E2E_BASE_URL },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { sessionId: string; workspaceUrl: string; instruction: string };
}

async function cleanup(page: Page, runnerApi: StackFixtures['runnerApi'], ids: string[]) {
  for (const sessionId of ids) {
    const session = await runnerApi('getSession', { params: { sessionId } }).catch(() => null);
    if (session?.live) await runnerApi('stopSession', { params: { sessionId }, body: { force: true } }).catch(() => undefined);
    await page.request.delete(`/api/sessions/${sessionId}`, { headers: { origin: E2E_BASE_URL } }).catch(() => undefined);
  }
}

test('D06 / M06 : capacité, sessions en cours et historique lus du runner et de la base', async ({ page, stack }) => {
  const seeded = stack.seeded.sessions!;
  await openSessions(page);

  const capacity = visible(page, 'section[aria-label="Capacité"]');
  await expect(capacity).toBeVisible();
  await expect(capacity).toContainText(isMobile() ? /\d+ sessions? sur \d+/ : /\d+ sessions? actives? sur \d+ autorisées?/);
  await expect(capacity.getByRole('meter')).toBeVisible();

  await expect(page.getByRole('heading', { name: /En cours · \d+/i })).toBeVisible();
  const waiting = visible(page, `[data-session-card="${seeded.waitingPermission!.id}"]`);
  await expect(waiting).toContainText('Autorisation demandée');
  await expect(waiting.getByRole('link', { name: 'Répondre' })).toHaveAttribute('href', new RegExp(`^/workspace/${seeded.waitingPermission!.id}`));
  const running = visible(page, `[data-session-card="${seeded.running!.id}"]`);
  await expect(running.getByRole('link', { name: 'Ouvrir' })).toHaveAttribute('href', `/workspace/${seeded.running!.id}`);

  if (isMobile()) {
    // M06: the session waiting for the owner comes first in the rail.
    const first = page.locator('ul[aria-label="Sessions en cours"]:visible > li').first();
    await expect(first.locator(`[data-session-card="${seeded.waitingPermission!.id}"]`)).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Toutes' })).toBeVisible();
  } else {
    await expect(page.getByRole('button', { name: /Démarrer une session/ })).toBeVisible();
    await expect(page.getByText('Reprendre rouvre la conversation enregistrée par Claude Code (claude --resume) dans son worktree.', { exact: false })).toBeVisible();
  }

  const history = visible(page, 'ul[aria-label="Historique des sessions"]');
  await expect(history).toContainText(seeded.finished!.title);
  await expect(history).toContainText(seeded.interrupted!.title);
});

test('Filtres de l\'historique dans l\'URL (statut, recherche)', async ({ page, stack }) => {
  const seeded = stack.seeded.sessions!;
  await openSessions(page);
  if (isMobile()) {
    await page.getByRole('radio', { name: 'Terminées' }).click();
  } else {
    await page.getByRole('combobox', { name: 'Statut' }).click();
    await page.getByRole('option', { name: 'terminées' }).click();
  }
  await expect(page).toHaveURL(/filtre=terminees/);
  const history = visible(page, 'ul[aria-label="Historique des sessions"]');
  await expect(history).toContainText(seeded.finished!.title);
  await expect(history).not.toContainText(seeded.interrupted!.title);

  if (isMobile()) await page.getByRole('button', { name: 'Rechercher une session' }).click();
  await visible(page, 'input[aria-label="Rechercher une session"]').fill('aucune-session-ne-porte-ce-nom');
  await expect(page).toHaveURL(/q=aucune-session-ne-porte-ce-nom/);
  await expect(page.getByText('Aucune session ne correspond')).toBeVisible();
  await page.getByRole('button', { name: 'Effacer les filtres' }).click();
  await expect(page).not.toHaveURL(/filtre=|q=/);
  await expect(visible(page, 'ul[aria-label="Historique des sessions"]')).toContainText(seeded.interrupted!.title);
});

test('Nouvelle session : la fenêtre crée le worktree et la session, puis ouvre le Workspace', async ({ page, stack, runnerApi }) => {
  const title = `Essai e2e ${unique()}`;
  await openSessions(page);
  await page.getByRole('button', { name: 'Nouvelle session', exact: true }).filter({ visible: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Nouvelle session' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/sessions? actives? sur \d+ possibles?/)).toBeVisible({ timeout: 30_000 });
  await dialog.getByLabel('Titre').fill(title);
  const branchField = dialog.getByLabel('Nom de la nouvelle branche');
  await expect(branchField).toHaveValue(/^feature\/essai-e2e-/);
  // Validation stays inline.
  await branchField.fill('mauvais nom');
  await dialog.getByRole('button', { name: 'Créer la session' }).click();
  await expect(dialog.getByText(/Nom de branche invalide/)).toBeVisible();
  const branch = `test/dialogue-${unique()}`;
  await branchField.fill(branch);
  await expect(dialog.getByText(new RegExp(`Worktree dialogue-.* créé depuis main\\.`))).toBeVisible();
  await dialog.getByRole('button', { name: 'Créer la session' }).click();
  await page.waitForURL(/\/workspace\/[0-9a-f-]{36}/, { timeout: 120_000 });
  const sessionId = page.url().split('/workspace/')[1]!.split(/[?#]/)[0]!;
  try {
    const session = await runnerApi('getSession', { params: { sessionId } });
    expect(session).toMatchObject({ title, status: 'new', permissionMode: 'manual' });
    expect(session.worktree?.branch).toBe(branch);
    expect(session.projectId).toBe(stack.seeded.projects!.devis!.id);
  } finally {
    await cleanup(page, runnerApi, [sessionId]);
  }
});

test('Renommer puis archiver une session prête depuis sa carte', async ({ page, stack, runnerApi }) => {
  const created = await apiCreate(page, stack.seeded.projects!.devis!.id, `À archiver ${unique()}`);
  try {
    await openSessions(page);
    const card = visible(page, `[data-session-card="${created.sessionId}"]`);
    await expect(card).toContainText('Prête');
    await card.getByRole('button', { name: /Autres actions/ }).click();
    await page.getByRole('menuitem', { name: 'Renommer' }).click();
    const rename = page.getByRole('dialog', { name: 'Renommer la session' });
    const newTitle = `Renommée ${unique()}`;
    await rename.getByLabel('Titre').fill(newTitle);
    await rename.getByRole('button', { name: 'Renommer' }).click();
    await expect(page.getByText(`Session renommée : ${newTitle}`, { exact: true })).toBeVisible();
    await expect(card).toContainText(newTitle);

    await card.getByRole('button', { name: /Autres actions/ }).click();
    await page.getByRole('menuitem', { name: 'Archiver' }).click();
    const confirm = page.getByRole('alertdialog', { name: `Archiver « ${newTitle} » ?` });
    await expect(confirm).toContainText('La session ne pourra plus être reprise.');
    await confirm.getByRole('button', { name: 'Archiver' }).click();
    await expect(page.getByText(`Session archivée : ${newTitle}`, { exact: true })).toBeVisible();
    await expect(card).toHaveCount(0);

    await openSessions(page, '?filtre=archivees');
    await expect(visible(page, 'ul[aria-label="Historique des sessions"]')).toContainText(newTitle);
  } finally {
    await cleanup(page, runnerApi, [created.sessionId]);
  }
});

test('Arrêter une session vivante (T8) puis la reprendre depuis l\'historique', async ({ page, stack, runnerApi, cli, waitForSessionStatus }) => {
  const instruction = await cli.script('sessions-e2e-court', { description: 'Tour court', steps: [{ final: 'Fait.' }] });
  const title = `Vivante ${unique()}`;
  const created = await apiCreate(page, stack.seeded.projects!.devis!.id, title, { instruction });
  try {
    await waitForSessionStatus(created.sessionId, 'waiting_input', { timeoutMs: 120_000 });
    await openSessions(page);
    const card = visible(page, `[data-session-card="${created.sessionId}"]`);
    await expect(card).toContainText("En attente d'instruction");
    await card.getByRole('button', { name: /Autres actions/ }).click();
    await page.getByRole('menuitem', { name: 'Arrêter la session' }).click();
    const confirm = page.getByRole('alertdialog', { name: `Arrêter « ${title} » ?` });
    await expect(confirm).toContainText("Claude Code reçoit Échap puis s'arrête, même au milieu d'une étape.");
    await expect(confirm).toContainText('La conversation reste reprenable depuis Sessions.');
    await confirm.getByRole('button', { name: 'Arrêter la session' }).click();
    await expect(page.getByText(`Session arrêtée : ${title}`, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveCount(0, { timeout: 30_000 });

    // The API refuses to stop what no longer runs.
    const again = await page.request.post(`/api/sessions/${created.sessionId}/stop`, { data: {}, headers: { origin: E2E_BASE_URL } });
    expect(again.status()).toBe(409);

    // History: « Arrêtée · reprise possible » → Reprendre.
    await openSessions(page, `?q=${encodeURIComponent(title)}`);
    if (isMobile()) {
      await page.getByRole('button', { name: new RegExp(`${title}.*actions`) }).click();
      const sheet = page.getByRole('dialog', { name: title });
      await expect(sheet).toContainText('Reprise possible');
      await sheet.getByRole('button', { name: 'Reprendre' }).click();
    } else {
      const row = visible(page, `li[data-session-id="${created.sessionId}"]`);
      await expect(row).toContainText('Arrêtée · reprise possible');
      await row.getByRole('button', { name: 'Reprendre' }).click();
    }
    await page.waitForURL(new RegExp(`/workspace/${created.sessionId}`), { timeout: 120_000 });
    await waitForSessionStatus(created.sessionId, ['running', 'waiting_input'], { timeoutMs: 120_000 });
  } finally {
    await cleanup(page, runnerApi, [created.sessionId]);
  }
});

test('Reprise impossible : « Pourquoi ? » explique le worktree supprimé', async ({ page, stack, runnerApi, cli, waitForSessionStatus }) => {
  const instruction = await cli.script('sessions-e2e-court', { description: 'Tour court', steps: [{ final: 'Fait.' }] });
  const title = `Sans worktree ${unique()}`;
  const created = await apiCreate(page, stack.seeded.projects!.devis!.id, title, { instruction });
  try {
    await waitForSessionStatus(created.sessionId, 'waiting_input', { timeoutMs: 120_000 });
    const stopped = await runnerApi('stopSession', { params: { sessionId: created.sessionId }, body: { force: true } });
    await runnerApi('removeWorktree', { params: { worktreeId: stopped.worktree!.id }, query: { force: true } });
    await openSessions(page, `?q=${encodeURIComponent(title)}`);
    if (isMobile()) {
      await page.getByRole('button', { name: new RegExp(`${title}.*actions`) }).click();
      const sheet = page.getByRole('dialog', { name: title });
      await expect(sheet).toContainText('Reprise impossible');
      await expect(sheet).toContainText(`Le worktree ${stopped.worktree!.name} a été supprimé`);
    } else {
      const row = visible(page, `li[data-session-id="${created.sessionId}"]`);
      await expect(row).toContainText('Reprise impossible');
      await row.getByRole('button', { name: 'Pourquoi ?' }).click();
      const why = page.getByRole('dialog', { name: 'Reprise impossible' });
      await expect(why).toContainText(`Le worktree ${stopped.worktree!.name} a été supprimé`);
      await expect(why.getByRole('link', { name: "Voir l'historique" })).toHaveAttribute('href', `/workspace/${created.sessionId}`);
    }
  } finally {
    await cleanup(page, runnerApi, [created.sessionId]);
  }
});

test('API : validation, Origin et capacité', async ({ page, stack }) => {
  const projectId = stack.seeded.projects!.devis!.id;
  const noOrigin = await page.request.post('/api/sessions', { data: { projectId, branch: { mode: 'primary' } }, headers: { origin: 'https://evil.example' } });
  expect(noOrigin.status()).toBe(403);
  const invalid = await page.request.post('/api/sessions', { data: { projectId, branch: { mode: 'new', branch: 'a..b' } }, headers: { origin: E2E_BASE_URL } });
  expect(invalid.status()).toBe(422);
  const bypass = await page.request.post('/api/sessions', {
    data: { projectId, branch: { mode: 'new', branch: `test/${unique()}` }, permissionMode: 'bypassPermissions' },
    headers: { origin: E2E_BASE_URL },
  });
  expect(bypass.status()).toBe(403);
  const list = await page.request.get('/api/sessions?statut=history&filtre=terminees');
  expect(list.status()).toBe(200);
  const body = (await list.json()) as { items: Array<{ status: string }> };
  expect(body.items.every((item) => item.status === 'finished')).toBe(true);
});
