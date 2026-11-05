import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { createDb } from '@nuera/db';
import { projects } from '@nuera/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { E2E_BASE_URL, E2E_DATABASE_URL, expect, test } from './fixtures';

/**
 * Lot PROJETS — D02/M02 list, the add flow (A1 → D03 → A2/A3, A4), the project page D04/M04 and its
 * APIs, against the stack's REAL runner (git clones from the local bare remotes), fake GitHub and
 * database.
 *
 *   E2E_STACK=projects pnpm --filter @nuera/web e2e projects.spec.ts
 *
 * Idempotent: the repository cloned by each project (`atelier-test/site-vitrine` on desktop,
 * `dev-test/notes-perso` on mobile) is removed again (row + clone of THIS stack) before the test.
 */
test.describe.configure({ mode: 'serial' });

const isMobile = () => test.info().project.name === 'mobile';
const origin = { origin: E2E_BASE_URL };

async function forgetClone(fullName: string, projectsRoot: string) {
  const db = createDb(E2E_DATABASE_URL, { max: 1, applicationName: 'e2e-projets' });
  try {
    const rows = await db.select().from(projects).where(eq(projects.githubFullName, fullName));
    for (const row of rows) {
      await db.delete(projects).where(eq(projects.id, row.id));
      const folder = path.resolve(row.path);
      if (folder.startsWith(path.resolve(projectsRoot) + path.sep) && existsSync(folder)) rmSync(folder, { recursive: true, force: true });
    }
    const folder = path.join(projectsRoot, fullName.split('/')[1]!);
    if (existsSync(folder)) rmSync(folder, { recursive: true, force: true });
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

async function projectIdOf(fullName: string): Promise<string | null> {
  const db = createDb(E2E_DATABASE_URL, { max: 1, applicationName: 'e2e-projets' });
  try {
    const [row] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.githubFullName, fullName), isNull(projects.archivedAt))).limit(1);
    return row?.id ?? null;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

async function openList(page: Page) {
  await page.goto('/projets');
  await expect(page.getByRole('heading', { name: 'Projets', exact: true })).toBeVisible({ timeout: 120_000 });
}

test('liste des projets : compteurs, recherche, filtres et favoris (D02 / M02)', async ({ page, stack }) => {
  const devis = stack.seeded.projects!.devis!;
  await openList(page);
  const list = page.getByRole(isMobile() ? 'list' : 'table', { name: 'Projets' });
  await expect(list.getByText('Devis Express', { exact: true })).toBeVisible();
  await expect(list.getByText('atelier-test/catalogue-produits')).toBeVisible();
  await expect(page.getByText(isMobile() ? /dépôts sur VPS-3/ : /dépôts clonés sur VPS-3/)).toBeVisible();

  // Search → URL state, then back to everything.
  const search = page.getByRole('searchbox', { name: 'Rechercher un projet' }).locator('visible=true');
  await search.fill('catalogue');
  await expect(page).toHaveURL(/q=catalogue/);
  await expect(list.getByText('Devis Express', { exact: true })).toBeHidden();
  await expect(list.getByText('Catalogue produits', { exact: true })).toBeVisible();
  await search.fill('');
  await expect(page).not.toHaveURL(/q=/);

  // Favourites chip.
  await page.getByRole('radio', { name: /^Favoris · \d+$/ }).click();
  await expect(page).toHaveURL(/filtre=favoris/);
  await expect(list.getByText('Devis Express', { exact: true })).toBeVisible();
  await expect(list.getByText('Outils CLI', { exact: true })).toBeHidden();
  await page.getByRole('radio', { name: /^Tous · \d+$/ }).click();

  // Star toggle (persisted).
  const star = page.getByRole('button', { name: 'Ajouter Outils CLI aux favoris' }).locator('visible=true');
  await star.click();
  await expect(page.getByRole('button', { name: 'Retirer Outils CLI des favoris' }).locator('visible=true')).toBeVisible();
  await page.getByRole('button', { name: 'Retirer Outils CLI des favoris' }).locator('visible=true').click();
  await expect(page.getByRole('button', { name: 'Ajouter Outils CLI aux favoris' }).locator('visible=true')).toBeVisible();

  // Opening a project.
  await (isMobile() ? list.getByRole('link', { name: 'Devis Express' }) : list.getByRole('link', { name: 'Ouvrir' }).first()).click();
  await expect(page).toHaveURL(new RegExp(`/projets/${devis.id}`));
});

test('ajout d\'un projet : dépôt, configuration, clonage réel puis projet prêt (A1 → D03 → A2 → A3)', async ({ page, stack }) => {
  const fullName = isMobile() ? 'dev-test/notes-perso' : 'atelier-test/site-vitrine';
  await forgetClone(fullName, stack.paths.projects);
  await openList(page);
  if (isMobile()) await page.getByRole('link', { name: 'Ajouter un projet' }).locator('visible=true').click();
  else await page.getByRole('link', { name: 'Ajouter un projet' }).first().click();
  await expect(page).toHaveURL(/\/projets\/nouveau/);

  const flow = isMobile() ? page.getByRole('dialog', { name: 'Ajouter un projet' }) : page.getByRole('dialog', { name: 'Ajouter un projet' });
  await expect(flow.getByRole('radiogroup', { name: 'Dépôts accessibles' })).toBeVisible({ timeout: 60_000 });
  // Already cloned repositories are disabled.
  await expect(flow.getByRole('radio', { name: /atelier-test\/devis-express/ })).toHaveAttribute('aria-disabled', 'true');
  await flow.getByRole('searchbox', { name: 'Rechercher un dépôt' }).fill(fullName.split('/')[1]!);
  await flow.getByRole('radio', { name: new RegExp(fullName) }).click();
  await flow.getByRole('button', { name: 'Continuer' }).click();
  await expect(page).toHaveURL(/etape=configuration/);

  // D03: prefilled name and destination (checked by the runner), then the clone.
  const name = flow.getByLabel('Nom dans Nuera Dev');
  await expect(name).not.toHaveValue('', { timeout: 60_000 });
  await name.fill(isMobile() ? 'Notes perso · e2e' : 'Site vitrine · e2e');
  await expect(flow.getByLabel('Destination sur VPS-3')).toHaveValue(new RegExp(`${fullName.split('/')[1]}$`));
  await expect(flow.getByText(/Dossier vide requis/)).toBeVisible({ timeout: 30_000 });
  await flow.getByRole('button', { name: 'Cloner sur VPS-3' }).click();

  // A2 → A3 (real git clone + install from the local remote).
  await expect(page).toHaveURL(/etape=clonage/);
  await expect(flow.getByText(/est prêt$/)).toBeVisible({ timeout: 240_000 });
  await expect(flow.getByText('Dossier', { exact: true })).toBeVisible();
  await flow.getByRole('link', { name: 'Voir le projet' }).click();
  await expect(page).toHaveURL(/\/projets\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { level: 1, name: isMobile() ? 'Notes perso · e2e' : 'Site vitrine · e2e' }).locator('visible=true')).toBeVisible({ timeout: 60_000 });
  // The intercepted modal is gone after the navigation.
  await expect(page.getByRole('dialog', { name: 'Ajouter un projet' })).toBeHidden();
});

test('A4 : un dossier non vide est refusé sans rien écraser, avec un dossier libre proposé', async ({ page, stack }) => {
  test.skip(isMobile(), 'Même logique que le bureau ; le parcours téléphone est couvert par le test précédent.');
  const fullName = 'atelier-test/site-vitrine';
  const devisPath = stack.seeded.projects!.devis!.path;
  const id = await projectIdOf(fullName);
  await forgetClone('dev-test/notes-perso', stack.paths.projects);
  // Try to clone another repository into a folder that is already used (Devis Express).
  const response = await page.request.post('/api/projects', {
    headers: origin,
    data: { fullName: 'dev-test/notes-perso', name: 'Essai A4', destination: devisPath, installDeps: false, worktreePerSession: true, readClaudeMd: true, commands: {} },
  });
  const body = (await response.json()) as { error?: { reason?: string; untouched?: string; data?: { fileCount?: number; suggestedPath?: string } } };
  expect(response.status()).toBe(409);
  expect(body.error?.reason).toBe('DESTINATION_NOT_EMPTY');
  expect(body.error?.untouched).toBe("Rien n'a été écrasé.");
  expect(body.error?.data?.fileCount).toBeGreaterThan(0);
  expect(body.error?.data?.suggestedPath).toBeTruthy();
  expect(id).not.toBeNull();

  // Same refusal in the UI (A4 state): banner, field in error, suggestion fills the field.
  await page.goto('/projets/nouveau?etape=configuration&depot=dev-test%2Fnotes-perso');
  const flow = page.getByRole('region', { name: 'Ajouter un projet' }).or(page.locator('section[aria-labelledby="ajout-projet-titre"]'));
  const destination = flow.getByLabel('Destination sur VPS-3');
  await expect(destination).not.toHaveValue('', { timeout: 60_000 });
  await destination.fill(devisPath);
  await expect(flow.getByText(/contient déjà/)).toBeVisible({ timeout: 30_000 });
  await flow.getByRole('button', { name: 'Cloner sur VPS-3' }).click();
  await expect(flow.getByText("Le dossier de destination n'est pas vide")).toBeVisible();
  await expect(flow.getByText(/Rien n'a été écrasé\./)).toBeVisible();
  await flow.getByRole('button', { name: /^Utiliser / }).click();
  await expect(destination).not.toHaveValue(devisPath);
  await expect(flow.getByRole('button', { name: 'Cloner sur VPS-3' })).toBeEnabled();
});

test('page du projet : commandes réelles, variables, branche, synchronisation (D04 / M04)', async ({ page, stack }) => {
  const devis = stack.seeded.projects!.devis!;
  await page.goto(`/projets/${devis.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Devis Express' }).locator('visible=true')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('heading', { name: isMobile() ? 'Environnement' : 'Environnement de développement', exact: true }).locator('visible=true')).toBeVisible();

  // « Lancer » Tests → real run in the runner, live badge until the result.
  await page.getByRole('button', { name: 'Lancer Tests' }).locator('visible=true').click();
  await expect(page.getByText(/13 \/ 13/).locator('visible=true').first()).toBeVisible({ timeout: 120_000 });

  // Environnement tab (URL state) with the run output.
  if (!isMobile()) {
    await page.getByRole('tab', { name: 'Environnement' }).click();
    await expect(page).toHaveURL(/onglet=environnement/);
    await page.getByRole('button', { name: 'Voir la sortie' }).first().click();
    const output = page.getByRole('dialog', { name: 'Sortie de la commande' });
    await expect(output.getByText(/npm run test/).first()).toBeVisible();
    await output.getByRole('button', { name: 'Fermer' }).last().click();
    await page.goBack();
    await expect(page).not.toHaveURL(/onglet=/);
  }

  // Variables: a secret is never sent back.
  const key = isMobile() ? 'E2E_SECRET_MOBILE' : 'E2E_SECRET_BUREAU';
  const existing = (await (await page.request.get(`/api/projects/${devis.id}/env`)).json()) as { variables: Array<{ id: string; key: string }> };
  for (const variable of existing.variables.filter((v) => v.key === key)) {
    await page.request.delete(`/api/projects/${devis.id}/env`, { headers: origin, data: { id: variable.id } });
  }
  await page.goto(`/projets/${devis.id}?onglet=variables`);
  await page.getByRole('button', { name: 'Ajouter' }).locator('visible=true').click();
  const dialog = page.getByRole('dialog', { name: 'Ajouter une variable' });
  await dialog.getByLabel('Nom').fill(key);
  await dialog.getByLabel('Valeur', { exact: true }).fill('valeur-tres-secrete');
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText(key).locator('visible=true').first()).toBeVisible();
  const listed = (await (await page.request.get(`/api/projects/${devis.id}/env`)).json()) as { variables: Array<{ key: string; value: string | null; secret: boolean }> };
  expect(listed.variables.find((v) => v.key === key)).toMatchObject({ secret: true, value: null });
  expect(await page.content()).not.toContain('valeur-tres-secrete');

  // New branch (desktop: Branches tab; phone: actions sheet).
  // Fixed name: the first run creates it, the next ones meet the BRANCH_EXISTS refusal (shown in the dialog).
  const branch = `test/e2e-${isMobile() ? 'mobile' : 'bureau'}`;
  const before = (await (await page.request.get(`/api/projects/${devis.id}/branches`)).json()) as { items: Array<{ name: string }> };
  const existed = before.items.some((b) => b.name === branch);
  if (isMobile()) {
    await page.getByRole('button', { name: 'Actions du projet' }).click();
    await page.getByRole('button', { name: 'Nouvelle branche…' }).click();
  } else {
    await page.goto(`/projets/${devis.id}?onglet=branches`);
    await page.getByRole('button', { name: 'Nouvelle branche' }).first().click();
  }
  const branchDialog = page.getByRole('dialog', { name: 'Nouvelle branche' });
  await branchDialog.getByLabel('Nom de la branche').fill(branch);
  await branchDialog.getByRole('button', { name: 'Créer la branche' }).click();
  if (existed) {
    await expect(branchDialog.getByText(/existe déjà/)).toBeVisible();
    await branchDialog.getByRole('button', { name: 'Annuler' }).click();
  }
  await expect(branchDialog).toBeHidden();
  const branches = (await (await page.request.get(`/api/projects/${devis.id}/branches`)).json()) as { items: Array<{ name: string }> };
  expect(branches.items.map((b) => b.name)).toContain(branch);

  // Sync (fetch + fast-forward with a read token from the fake GitHub).
  await page.getByRole('button', { name: 'Synchroniser' }).locator('visible=true').click();
  await expect(page.getByText(/Devis Express (est à jour|synchronisé)/).first()).toBeVisible({ timeout: 60_000 });
});

test('CLAUDE.md : modification committée par le runner (D04)', async ({ page, stack }) => {
  const devis = stack.seeded.projects!.devis!;
  const marker = `<!-- e2e ${isMobile() ? 'mobile' : 'bureau'} ${Date.now()} -->`;
  await page.goto(`/projets/${devis.id}${isMobile() ? '' : '?onglet=claude-md'}`);
  await page.getByRole('button', { name: 'Modifier', exact: true }).locator('visible=true').first().click();
  const editor = page.getByRole('dialog', { name: 'Modifier CLAUDE.md' });
  const content = editor.getByLabel('Contenu');
  await expect(content).not.toHaveValue('');
  await content.fill(`${await content.inputValue()}\n${marker}\n`);
  await editor.getByRole('button', { name: 'Enregistrer et committer' }).click();
  await expect(page.getByText(/^CLAUDE\.md enregistré · commit [0-9a-f]{7}$/, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  await expect(editor).toBeHidden();
  const md = (await (await page.request.get(`/api/projects/${devis.id}/claude-md`)).json()) as { content: string | null; lastCommit: { subject?: string } | null };
  expect(md.content).toContain(marker);
});

test('onglets du téléphone : la puce choisie reste visible (M04)', async ({ page, stack }) => {
  test.skip(!isMobile(), 'Rangée de puces défilante propre au téléphone.');
  const devis = stack.seeded.projects!.devis!;
  await page.goto(`/projets/${devis.id}?onglet=variables`);
  const chip = page.getByRole('tab', { name: /^Variables/ }).locator('visible=true');
  await expect(chip).toHaveAttribute('data-state', 'active', { timeout: 60_000 });
  await expect(chip).toBeInViewport({ ratio: 1 });
  // The Environnement tab keeps the phone rows (44 px run buttons), with no horizontal scroll.
  await page.getByRole('tab', { name: 'Environnement' }).locator('visible=true').click();
  await expect(page).toHaveURL(/onglet=environnement/);
  await expect(page.getByRole('button', { name: 'Lancer Lint' }).locator('visible=true')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('archiver puis restaurer un projet (T8)', async ({ page, stack }) => {
  test.skip(isMobile(), 'Le menu de ligne est propre au bureau (M02 n\'en a pas) ; la feuille M04 porte la même action.');
  const outils = stack.seeded.projects!.outils!;
  await openList(page);
  await page.getByRole('button', { name: 'Actions pour Outils CLI' }).click();
  await page.getByRole('menuitem', { name: 'Archiver le projet…' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Archiver Outils CLI ?' });
  await expect(confirm.getByText("Le dépôt GitHub n'est jamais touché.")).toBeVisible();
  await confirm.getByRole('button', { name: 'Archiver' }).click();
  await expect(page.getByText('Outils CLI archivé').first()).toBeVisible();
  await page.getByRole('radio', { name: /^Archivés · \d+$/ }).click();
  await expect(page.getByRole('table', { name: 'Projets' }).getByText('Outils CLI')).toBeVisible();
  await page.getByRole('button', { name: 'Restaurer' }).click();
  await expect(page.getByText('Outils CLI restauré').first()).toBeVisible();
  const detail = await page.request.get(`/api/projects/${outils.id}`);
  expect(((await detail.json()) as { project: { archivedAt: string | null } }).project.archivedAt).toBeNull();
});

test('API : routes protégées et Origin vérifiée', async ({ page, stack }) => {
  const devis = stack.seeded.projects!.devis!;
  const noOrigin = await page.request.post(`/api/projects/${devis.id}/sync`, { headers: { origin: 'https://evil.example' } });
  expect(noOrigin.status()).toBe(403);
  const bad = await page.request.post('/api/runs', { headers: origin, data: { projectId: devis.id, kind: 'nope' } });
  expect(bad.status()).toBe(422);
});
