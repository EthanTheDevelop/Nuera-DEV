import { randomUUID } from 'node:crypto';
import { createDb } from '@nuera/db';
import { projects, sessions } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { E2E_BASE_URL, E2E_DATABASE_URL, expect, requireAccounts, test, type StackState } from './fixtures';

/**
 * SERVEUR PARTAGÉ (lot P1) — A (propriétaire) et B (membre) travaillent sur le MÊME serveur « VPS-3 »
 * (pile `up --accounts 2 --shared`), chacun dans son espace et avec SA PROPRE connexion Claude Code :
 *   1. A voit Claude Code connecté (le dossier existant du serveur), B voit « pas connecté » et
 *      « Se reconnecter dans un terminal » (son propre dossier, vide) ;
 *   2. un projet et une session de A répondent à B exactement comme des identifiants inconnus (404) ;
 *   3. Administration › Serveurs liste les deux comptes du serveur (bureau) ;
 *   4. au téléphone, B voit le même état (T6) et la mention du serveur partagé dans Paramètres › Serveur.
 *
 *   node apps/web/e2e/harness/stack.mjs up --name partage --web-port 3670 --accounts 2 --shared
 *   node apps/web/e2e/harness/stack.mjs e2e --name partage -- partage.spec.ts
 */
requireAccounts(2);

const origin = { origin: E2E_BASE_URL };
const UNKNOWN = '0b9d8c7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e';
const database = createDb(E2E_DATABASE_URL, { max: 2, applicationName: 'e2e-partage' });
test.afterAll(async () => {
  await database.$client.end({ timeout: 5 });
});

function sharedOnly(stack: StackState): void {
  test.skip(stack.options.shared !== true, 'pile sans serveur partagé : lancez `up --shared`.');
}

/** A project and a session of A on the shared server (rows only: no clone needed for the isolation probes). */
async function foreignRows(stack: StackState): Promise<{ project: string; session: string }> {
  const owner = stack.accounts.find((account) => account.key === 'a')!;
  const server = stack.runners.find((runner) => runner.key === 'a')!;
  const slug = `partage-a-${Date.now().toString(36)}`;
  const [project] = await database
    .insert(projects)
    .values({
      spaceId: owner.spaceId!,
      environmentId: server.environmentId!,
      slug,
      name: 'Projet de A',
      githubFullName: `atelier-test/${slug}`,
      cloneUrl: `https://github.com/atelier-test/${slug}.git`,
      path: `/srv/e2e/${slug}`,
      status: 'ready',
    })
    .returning({ id: projects.id });
  const session = randomUUID();
  await database.insert(sessions).values({ id: session, projectId: project!.id, environmentId: server.environmentId!, title: 'Session de A', status: 'waiting_input' });
  return { project: project!.id, session };
}

test.describe('serveur partagé · bureau', () => {
  test.skip(({ isMobile }) => isMobile, 'contextes des deux comptes ouverts par le test');

  test("chaque compte a sa propre connexion Claude Code ; B ne voit rien de l'espace de A", async ({ page, stack, as }) => {
    sharedOnly(stack);
    const b = await as('b');
    // The account's own Claude Code status (its own CLI folder on the shared server).
    const claudeA = (await (await page.request.get('/api/claude/status?refresh=1')).json()) as { state: string };
    const claudeB = (await (await b.page.request.get('/api/claude/status?refresh=1')).json()) as { state: string };
    expect(claudeA.state).toBe('connected');
    expect(claudeB.state).toBe('disconnected');

    await page.goto('/parametres?onglet=claude-code');
    await expect(page.getByText("Claude Code n'est plus connecté à votre compte Claude")).toHaveCount(0);
    await expect(page.getByText('Connecté', { exact: true }).first()).toBeVisible();

    await b.page.goto('/parametres?onglet=claude-code');
    await expect(b.page.getByText("Claude Code n'est plus connecté à votre compte Claude").first()).toBeVisible();
    await expect(b.page.getByRole('link', { name: 'Se reconnecter dans un terminal' }).first()).toBeVisible();

    const ids = await foreignRows(stack);
    for (const path of [`/api/projects/${ids.project}`, `/api/sessions/${ids.session}`]) {
      const foreign = await b.page.request.get(path, { headers: origin });
      const unknown = await b.page.request.get(path.replace(/[0-9a-f-]{36}$/, UNKNOWN), { headers: origin });
      expect(foreign.status(), path).toBe(404);
      expect(foreign.status(), path).toBe(unknown.status());
      expect(await foreign.json(), path).toEqual(await unknown.json());
      // A still reads its own rows.
      expect((await page.request.get(path, { headers: origin })).status(), path).not.toBe(404);
    }
    const listB = await b.page.request.get('/api/projects');
    expect(listB.status()).toBe(200);
    expect(await listB.text()).not.toContain(ids.project);
    await b.page.goto(`/workspace/${ids.session}`);
    await expect(b.page.getByText('Projet de A')).toHaveCount(0);

    await database.delete(sessions).where(eq(sessions.id, ids.session));
    await database.delete(projects).where(eq(projects.id, ids.project));
  });

  test('Administration › Serveurs liste les deux comptes du serveur', async ({ page, stack }) => {
    sharedOnly(stack);
    await page.goto('/administration?onglet=serveurs');
    await page.getByRole('button', { name: 'Actions sur le serveur VPS-3' }).first().click();
    await page.getByRole('menuitem', { name: /Comptes du serveur · 2/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Comptes du serveur VPS-3' });
    await expect(dialog).toBeVisible();
    for (const account of stack.accounts.filter((item) => item.key === 'a' || item.key === 'b')) {
      await expect(dialog.getByText(account.name, { exact: true })).toBeVisible();
    }
    await expect(dialog.getByText('Premier compte', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Retirer' })).toHaveCount(1);
  });
});

test.describe('serveur partagé · téléphone', () => {
  test.skip(({ isMobile }) => !isMobile, 'parcours téléphone');

  test('B voit sa propre connexion Claude Code et le serveur partagé', async ({ stack, as }) => {
    sharedOnly(stack);
    const b = await as('b', { mobile: true });
    await b.page.goto('/parametres?onglet=claude-code');
    await expect(b.page.getByText("Claude Code n'est plus connecté à votre compte Claude").first()).toBeVisible();
    await b.page.goto('/parametres?onglet=serveur');
    await expect(b.page.getByText(/Serveur partagé entre 2 comptes/).first()).toBeVisible();
  });
});
