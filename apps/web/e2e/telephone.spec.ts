import { expect, test } from './fixtures';

/**
 * Phone specifics (projet `mobile`): in-page tabs never fill the history (the back arrow leaves the page),
 * text fields render at 16 px (iOS zooms into a smaller one) and the composer keeps its field.
 *
 *   node apps/web/e2e/harness/stack.mjs e2e --name mobile -- telephone.spec.ts --project=mobile
 */
test.beforeEach(async ({ seed }) => {
  test.skip(test.info().project.name !== 'mobile', 'Téléphone seulement.');
  await seed('projects', 'sessions');
});

test('Workspace : les onglets remplacent l\'URL, le retour quitte la session', async ({ page }) => {
  await page.goto('/sessions');
  const link = page.locator('a[href^="/workspace/"]').filter({ visible: true }).first();
  await expect(link).toBeVisible({ timeout: 60_000 });
  await link.click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 60_000 });
  const tabs = page.getByRole('tablist', { name: 'Onglets du Workspace' });
  await expect(tabs).toBeVisible({ timeout: 60_000 });
  for (const name of ['Fichiers', /^Diff/, 'Git', 'Aperçu', 'Session', 'Fichiers']) {
    await tabs.getByRole('tab', { name }).click();
    await expect(tabs.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
  }
  await expect(page).toHaveURL(/onglet=fichiers/);

  // 16 px fields: no iOS zoom on focus; double-tap zoom off, pinch kept.
  const field = page.getByRole('textbox', { name: 'Instruction pour Claude' });
  await expect(field).toHaveCSS('font-size', '16px');
  await expect(field).toHaveCSS('touch-action', 'manipulation');
  await expect(page.getByRole('button', { name: "Options de l'instruction" })).toBeVisible();

  await page.evaluate(() => window.history.back());
  await expect(page).toHaveURL(/\/sessions(\?|$)/, { timeout: 30_000 });
});

test('Projet : les puces remplacent l\'URL, le retour revient à la liste', async ({ page }) => {
  await page.goto('/projets');
  await expect(page.locator('input').filter({ visible: true }).first()).toHaveCSS('font-size', '16px');
  const link = page.locator('a[href^="/projets/"]:not([href="/projets/nouveau"])').filter({ visible: true }).first();
  await expect(link).toBeVisible({ timeout: 60_000 });
  await link.click();
  const tabs = page.getByRole('tablist', { name: 'Sections du projet' }).filter({ visible: true });
  await expect(tabs).toBeVisible({ timeout: 60_000 });
  const triggers = tabs.getByRole('tab');
  const count = Math.min(await triggers.count(), 3);
  for (let i = 1; i < count; i += 1) await triggers.nth(i).click();
  await expect(page).toHaveURL(/onglet=/);
  await page.evaluate(() => window.history.back());
  await expect(page).toHaveURL(/\/projets(\?|$)/, { timeout: 30_000 });
});
