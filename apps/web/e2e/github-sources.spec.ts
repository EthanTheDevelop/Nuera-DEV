import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createDb } from '@nuera/db';
import { githubSources, projects } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { connectGithubSource } from './harness/github-connect';
import { E2E_BASE_URL, E2E_DATABASE_URL, controlFakeGithub, expect, fakeGithubState, requireAccounts, stackState, test, type StackState } from './fixtures';

/**
 * SOURCES GITHUB MULTIPLES (MULTICOMPTE §7) — the owner's space gets a second GitHub source (the
 * spare app `a2` of the fake GitHub, installed on atelier-test):
 *   - two sources with distinct GitHub App names (names are global on GitHub, 34 characters at most);
 *   - a repository reachable through both sources asks which one, in « Ajouter un projet »; the clone
 *     uses a token of the chosen source and the project row keeps it;
 *   - a source used by an active project cannot be disconnected; once the project is archived it can,
 *     and the projects of the other source keep working;
 *   - account B never sees the owner's sources.
 * Restores everything (project, source, binding of the spare app in the fake GitHub).
 *
 *   node apps/web/e2e/harness/stack.mjs e2e --name e2e -- github-sources.spec.ts --project desktop
 */
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'parcours de bureau');

const FULL_NAME = 'atelier-test/site-vitrine';
const database = createDb(E2E_DATABASE_URL, { max: 2, applicationName: 'e2e-sources' });
const origin = { origin: E2E_BASE_URL };
let secondSource: string | null = null;

function owner(stack: StackState) {
  return stack.accounts.find((account) => account.key === 'a')!;
}

async function forgetVitrine(stack: StackState) {
  const server = stack.runners.find((runner) => runner.key === 'a')!;
  const rows = await database.select().from(projects).where(and(eq(projects.githubFullName, FULL_NAME), eq(projects.environmentId, server.environmentId!)));
  for (const row of rows) {
    await database.delete(projects).where(eq(projects.id, row.id));
    const folder = path.resolve(row.path);
    if (folder.startsWith(path.resolve(server.paths.projects) + path.sep) && existsSync(folder)) rmSync(folder, { recursive: true, force: true });
  }
  // Leftovers of other specs (parcours 1 leaves a non-empty « site-vitrine » folder on purpose).
  const root = path.resolve(server.paths.projects);
  for (const entry of existsSync(root) ? readdirSync(root) : []) {
    if (entry === 'site-vitrine' || entry.startsWith('site-vitrine-')) rmSync(path.join(root, entry), { recursive: true, force: true });
  }
}

test.afterAll(async () => {
  test.setTimeout(3 * 60_000);
  const stack = await stackState();
  await forgetVitrine(stack);
  if (secondSource) await database.delete(githubSources).where(eq(githubSources.id, secondSource)).catch(() => undefined);
  // The spare app may be bound again by the next run (as if it had been deleted on GitHub).
  await controlFakeGithub({ release: 'a2', bindNext: null }).catch(() => undefined);
  await database.$client.end({ timeout: 5 });
});

test("une seconde source GitHub dans le même espace, avec un nom d'application distinct", async ({ page, stack }) => {
  test.setTimeout(5 * 60_000);
  await forgetVitrine(stack);
  const result = await connectGithubSource(page.request, stack, 'a', 'a2', () => undefined);
  expect(result.status).toBe('connected');
  secondSource = result.sourceId;
  const rows = await database.select({ id: githubSources.id, appId: githubSources.appId }).from(githubSources).where(eq(githubSources.spaceId, owner(stack).spaceId!));
  expect(rows.map((row) => row.appId).sort()).toEqual([stack.githubApps.find((app) => app.key === 'a')!.appId, stack.githubApps.find((app) => app.key === 'a2')!.appId].sort());

  const fake = await fakeGithubState();
  const names = fake.apps.filter((app) => app.bound && (app.key === 'a' || app.key === 'a2')).map((app) => app.manifest!.name);
  expect(names).toHaveLength(2);
  expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(2);
  for (const name of names) expect(name.length).toBeLessThanOrEqual(34);

  const overview = (await (await page.request.get('/api/integrations/github')).json()) as { sources?: Array<{ id: string; status: string }>; status: string };
  expect(overview.sources?.length).toBe(2);
  expect(overview.status).toBe('connected');
  await page.goto('/integrations');
  await expect(page.getByRole('heading', { name: 'Intégrations', level: 1 })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(stack.github.accounts[0]!.login, { exact: false }).first()).toBeVisible();
});

test('un dépôt atteint par deux sources : la source se choisit, le clonage utilise ses accès', async ({ page, stack }) => {
  test.skip(!secondSource, 'seconde source absente');
  test.setTimeout(6 * 60_000);
  await page.goto('/projets');
  await expect(page.getByRole('heading', { name: 'Projets', exact: true })).toBeVisible({ timeout: 120_000 });
  await page.getByRole('link', { name: 'Ajouter un projet' }).locator('visible=true').first().click();
  const flow = page.getByRole('dialog', { name: 'Ajouter un projet' });
  const list = flow.getByRole('radiogroup', { name: 'Dépôts accessibles' });
  await expect(list).toBeVisible({ timeout: 120_000 });
  await flow.getByRole('searchbox', { name: 'Rechercher un dépôt' }).fill('vitrine');
  await list.getByRole('radio', { name: new RegExp(FULL_NAME) }).first().click();
  await flow.getByRole('button', { name: 'Continuer' }).click();
  await expect(page).toHaveURL(/etape=configuration/);
  // The repository is reachable through both sources: « Source GitHub » asks which one.
  const source = flow.getByRole('combobox', { name: 'Source GitHub' });
  await expect(source).toBeVisible({ timeout: 60_000 });
  await source.click();
  const options = page.getByRole('option');
  await expect(options).toHaveCount(2);
  // The two sources must be told apart by their labels (both reach atelier-test).
  const labels = (await options.allInnerTexts()).map((text) => text.trim());
  expect(new Set(labels).size, `libellés des sources : ${labels.join(' / ')}`).toBe(2);
  // The oldest source comes first everywhere (MULTICOMPTE §14 W3-2): the second option is the new source.
  await options.nth(1).click();
  await flow.getByLabel('Nom dans Nuera Dev').fill('Site vitrine · seconde source');
  const server = stack.runners.find((runner) => runner.key === 'a')!.name;
  const sent = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/projects');
  await flow.getByRole('button', { name: `Cloner sur ${server}` }).click();
  expect(((await sent).postDataJSON() as { sourceId?: string }).sourceId, 'source envoyée par le formulaire').toBe(secondSource);
  await expect(flow.getByText(/est prêt$/)).toBeVisible({ timeout: 240_000 });

  const [row] = await database.select().from(projects).where(and(eq(projects.githubFullName, FULL_NAME), eq(projects.spaceId, owner(stack).spaceId!)));
  // The project keeps the source chosen in the form, not the space's default one.
  expect(row!.githubSourceId).toBe(secondSource);
});

test("une source utilisée par un projet actif ne se déconnecte pas ; l'autre source continue de servir ses projets", async ({ page, stack }) => {
  test.skip(!secondSource, 'seconde source absente');
  const [row] = await database.select().from(projects).where(and(eq(projects.githubFullName, FULL_NAME), eq(projects.spaceId, owner(stack).spaceId!)));
  expect(row, 'projet cloné par la seconde source (test précédent)').toBeTruthy();
  const refused = await page.request.delete(`/api/integrations/github/sources/${secondSource}`, { headers: origin });
  expect(refused.status(), await refused.text()).toBe(409);
  const refusal = (await refused.json()) as { error: { projects?: Array<{ id: string }> } };
  expect(refusal.error.projects?.map((project) => project.id)).toEqual([row!.id]);
  // Archive the project, then the source can go.
  expect((await page.request.delete(`/api/projects/${row!.id}`, { data: { removeClone: true }, headers: { ...origin, 'content-type': 'application/json' } })).status()).toBeLessThan(300);
  const removed = await page.request.delete(`/api/integrations/github/sources/${secondSource}`, { headers: origin });
  expect(removed.status(), await removed.text()).toBeLessThan(300);
  expect(await database.select({ id: githubSources.id }).from(githubSources).where(eq(githubSources.id, secondSource!))).toHaveLength(0);
  secondSource = null;
  // Devis Express (first source) still syncs with GitHub.
  const sync = await page.request.post(`/api/projects/${stack.seeded.projects!.devis!.id}/sync`, { headers: origin });
  expect(sync.status(), await sync.text()).toBeLessThan(300);
});

test('B ne voit jamais les sources du propriétaire', async ({ as, stack }) => {
  requireAccounts(2);
  const b = await as('b');
  const overview = JSON.stringify(await (await b.page.request.get('/api/integrations/github')).json());
  // Exact slugs (B's own app is « <slug>-b »).
  for (const app of stack.githubApps.filter((item) => item.account === 'a' || item.key === 'a2')) expect(overview).not.toContain(`"${app.slug}"`);
  const own = stack.githubApps.find((app) => app.key === stack.accounts.find((account) => account.key === 'b')!.github.app)!;
  expect(overview).toContain(own.slug);
});
