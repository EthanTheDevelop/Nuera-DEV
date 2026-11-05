import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { createDb } from '@nuera/db';
import { auditLog, projects } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { E2E_DATABASE_URL, E2E_STACK_DIR, expect, hideNextDevIndicator, test, type StackState } from './fixtures';

/**
 * Parcours 1 (brief, flux obligatoire) — « GitHub connecté → choix du dépôt → clonage → projet →
 * Workspace », driven through the UI like the owner, on the stack's REAL runner (git clone from the
 * local bare remote, npm ci), fake GitHub, real database and the TEST-ONLY fake Claude CLI:
 *
 *   Intégrations (GitHub connected, its accounts) → Projets « Ajouter un projet » (D03 modal on
 *   desktop, M03 full screen on the phone) → account + search → A1 configuration (branch, name,
 *   destination, commands) → A4 (the default destination already holds files: refused, nothing
 *   overwritten, free folder proposed) → A2 live progress → A3 → D04 / M04 (branches, commands,
 *   CLAUDE.md read from the clone) → « Nouvelle session » → /workspace/<id>, the CLI running in a
 *   real worktree of the clone.
 *
 *   E2E_STACK=parcours1 E2E_SEED=github pnpm --filter @nuera/web e2e parcours-1-github-projet.spec.ts
 *
 * Idempotent: `atelier-test/site-vitrine` (never registered by `seed projects`) is forgotten again
 * before each project (rows, clone, worktrees, leftover folder of THIS stack only).
 */
test.describe.configure({ mode: 'serial' });

const FULL_NAME = 'atelier-test/site-vitrine';
const REPO = 'site-vitrine';
const ACCOUNT = 'atelier-test';
const BRANCH = 'refonte/accueil';
/** Owner-edited install command: the default one, slowed down so that A2 is observable. */
const INSTALL = 'sleep 3 && npm ci';
const SHOTS = path.join(E2E_STACK_DIR, 'shots', 'parcours-1');

const isMobile = () => test.info().project.name === 'mobile';
const device = () => (isMobile() ? 'mobile' : 'bureau');
const visible = (page: Page, selector: string) => page.locator(selector).locator('visible=true');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'safe.directory=*', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }).trim();
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await hideNextDevIndicator(page);
  await page.waitForTimeout(400); // dialog / sheet entrance
  await page.screenshot({ path: path.join(SHOTS, `${name}-${device()}.png`) });
}

const db = createDb(E2E_DATABASE_URL, { max: 2, applicationName: 'e2e-parcours-1' });

test.afterAll(async () => {
  await db.$client.end({ timeout: 5 });
});

/** Removes every trace of the repository in THIS stack (rows cascade: sessions, worktrees, runs). */
async function forgetRepository(stack: StackState) {
  const root = path.resolve(stack.paths.projects);
  const inside = (folder: string) => path.resolve(folder).startsWith(root + path.sep);
  const rows = await db.select().from(projects).where(eq(projects.githubFullName, FULL_NAME));
  for (const row of rows) {
    await db.delete(projects).where(eq(projects.id, row.id));
    if (inside(row.path)) rmSync(row.path, { recursive: true, force: true });
  }
  for (const entry of existsSync(root) ? readdirSync(root) : []) {
    if (entry === REPO || entry.startsWith(`${REPO}-`)) rmSync(path.join(root, entry), { recursive: true, force: true });
  }
  const worktrees = path.join(root, '.worktrees');
  for (const entry of existsSync(worktrees) ? readdirSync(worktrees) : []) {
    if (entry === REPO || entry.startsWith(`${REPO}-`)) rmSync(path.join(worktrees, entry), { recursive: true, force: true });
  }
}

test('parcours 1 · GitHub connecté → dépôt → clonage → projet → Workspace (avec A4)', async ({ page, stack, runnerApi, waitForSessionStatus, cli }) => {
  test.setTimeout(600_000);
  await forgetRepository(stack);
  const root = path.resolve(stack.paths.projects);
  const repo = stack.repos.find((item) => item.fullName === FULL_NAME)!;
  expect(repo, `${FULL_NAME} absent des dépôts de la pile`).toBeTruthy();
  // A leftover folder where the clone would go by default (A4 « Erreur récupérable »).
  const leftover = path.join(root, REPO);
  mkdirSync(leftover, { recursive: true });
  writeFileSync(path.join(leftover, 'brouillon.txt'), 'ancienne maquette, ne pas écraser\n');
  const started = new Date();
  let sessionId: string | null = null;

  try {
    // ---------------------------------------------------------------- 1. Intégrations: GitHub connected
    await page.goto('/integrations');
    await expect(page.getByRole('heading', { name: 'Intégrations', level: 1 })).toBeVisible({ timeout: 120_000 });
    if (isMobile()) {
      await expect(page.getByText(`${stack.repos.length} dépôts · contenu et pull requests en écriture`, { exact: false })).toBeVisible();
    } else {
      await expect(page.getByRole('heading', { name: 'GitHub · import et synchronisation des dépôts' })).toBeVisible();
      await expect(page.getByText(`${stack.repos.length} dépôts`, { exact: true })).toBeVisible();
    }
    for (const account of stack.github.accounts) await expect(page.getByText(account.login, { exact: false }).locator('visible=true').first()).toBeVisible();
    await shot(page, '1-integrations');

    // ---------------------------------------------------------------- 2. Projets → « Ajouter un projet »
    await page.goto('/projets');
    await expect(page.getByRole('heading', { name: 'Projets', exact: true })).toBeVisible({ timeout: 120_000 });
    await page.getByRole('link', { name: 'Ajouter un projet' }).locator('visible=true').first().click();
    await expect(page).toHaveURL(/\/projets\/nouveau/);
    const flow = page.getByRole('dialog', { name: 'Ajouter un projet' });
    await expect(flow).toBeVisible();
    if (isMobile()) await expect(flow.getByText('1 / 3', { exact: true })).toBeVisible();
    const list = flow.getByRole('radiogroup', { name: 'Dépôts accessibles' });
    await expect(list).toBeVisible({ timeout: 60_000 });
    await expect(list.getByRole('radio', { name: /atelier-test\/devis-express/ })).toHaveAttribute('aria-disabled', 'true');

    // Account (desktop chips; M03 has the search only) + search.
    if (!isMobile()) {
      await flow.getByRole('radio', { name: new RegExp(`^${ACCOUNT} · \\d+$`) }).click();
      await expect(list.getByRole('radio', { name: /dev-test\// })).toHaveCount(0);
    }
    await flow.getByRole('searchbox', { name: 'Rechercher un dépôt' }).fill('vitrine');
    await expect(list.getByRole('radio')).toHaveCount(1);
    await list.getByRole('radio', { name: new RegExp(FULL_NAME) }).click();
    await expect(list.getByRole('radio', { name: new RegExp(FULL_NAME) })).toHaveAttribute('aria-checked', 'true');
    await shot(page, '2-depot');
    await flow.getByRole('button', { name: 'Continuer' }).click();

    // ---------------------------------------------------------------- 3. Configuration (branch, name, destination, commands)
    await expect(page).toHaveURL(/etape=configuration/);
    const name = flow.getByLabel('Nom dans Nuera Dev');
    // Prefilled from the repository name (« site-vitrine » → « Site Vitrine »), then renamed.
    await expect(name).toHaveValue('Site Vitrine', { timeout: 60_000 });
    const projectName = `Site vitrine · ${device()}`;
    await name.fill(projectName);
    // Default destination = the leftover folder: the runner's live check says so before submitting.
    const destination = flow.getByLabel('Destination sur VPS-3');
    await expect(destination).toHaveValue(leftover);
    await expect(flow.getByText('Ce dossier contient déjà 1 fichier.')).toBeVisible({ timeout: 30_000 });
    // Starting branch (Radix Select, read from the fake GitHub).
    await flow.getByRole('combobox').filter({ hasText: 'main' }).click();
    await page.getByRole('option', { name: BRANCH }).click();
    await expect(flow.getByRole('combobox').filter({ hasText: BRANCH })).toBeVisible();
    // Commands detected from package.json (read through GitHub), the install one edited.
    await flow.locator('summary').filter({ hasText: 'Commandes du projet' }).click();
    await expect(flow.getByText('Trouvé à la racine. Claude Code le lit à chaque session.')).toBeVisible();
    await expect(flow.getByText('Détecté', { exact: true })).toBeVisible();
    await expect(flow.getByLabel('Installation')).toHaveValue('npm ci');
    await expect(flow.getByLabel('Lancement')).toHaveValue('npm run dev');
    await expect(flow.getByLabel('Build')).toHaveValue('npm run build');
    await expect(flow.getByLabel('Tests')).toHaveValue('');
    await flow.getByLabel('Installation').fill(INSTALL);
    await expect(flow.getByText(`Lance ${INSTALL} : le gestionnaire est détecté depuis package-lock.json.`)).toBeVisible();
    await shot(page, '3-configuration');

    // ---------------------------------------------------------------- 4. A4: refused, nothing overwritten, free folder
    await flow.getByRole('button', { name: 'Cloner sur VPS-3' }).click();
    await expect(flow.getByText("Le dossier de destination n'est pas vide")).toBeVisible({ timeout: 30_000 });
    await expect(flow.getByText(`${leftover} contient déjà 1 fichier. Rien n'a été écrasé.`)).toBeVisible();
    await expect(flow.getByRole('button', { name: 'Réessayer' })).toBeVisible();
    await shot(page, '4-a4');
    expect(readdirSync(leftover)).toEqual(['brouillon.txt']);
    expect(await db.select({ id: projects.id }).from(projects).where(eq(projects.githubFullName, FULL_NAME))).toHaveLength(0);
    const suggestion = flow.getByRole('button', { name: /^Utiliser .+ Dossier libre, proposé automatiquement$/ });
    const suggested = ((await suggestion.textContent()) ?? '').replace(/^Utiliser /, '').replace(/Dossier libre, proposé automatiquement$/, '').trim();
    expect(path.dirname(suggested)).toBe(root);
    expect(existsSync(suggested)).toBe(false);
    await suggestion.click();
    await expect(destination).toHaveValue(suggested);
    await expect(flow.getByText('Ce dossier contient déjà 1 fichier.')).toBeHidden({ timeout: 30_000 });
    // The edited form is kept (branch, name, commands).
    await expect(name).toHaveValue(projectName);

    // ---------------------------------------------------------------- 5. A2 live progress → A3
    await flow.getByRole('button', { name: 'Cloner sur VPS-3' }).click();
    await expect(page).toHaveURL(/etape=clonage/, { timeout: 30_000 });
    await expect(flow.getByText(`Clonage de ${FULL_NAME}`)).toBeVisible({ timeout: 30_000 });
    await expect(flow.getByRole('progressbar')).toBeVisible();
    await expect(flow.getByText(`(${INSTALL})`, { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(flow.getByRole('log', { name: 'Journal du clonage' })).toContainText(`$ ${INSTALL}`);
    await expect(flow.getByText(/Vous pouvez fermer : le clonage continue sur VPS-3\./).first()).toBeVisible();
    await shot(page, '5-a2');

    await expect(flow.getByText(`${projectName} est prêt`)).toBeVisible({ timeout: 240_000 });
    await expect(flow.getByText(suggested, { exact: true })).toBeVisible();
    await expect(flow.getByText(BRANCH, { exact: true })).toBeVisible();
    await expect(flow.getByText(/^trouvé à la racine · \d+ lignes$/)).toBeVisible();
    await expect(flow.getByRole('button', { name: 'Démarrer une session' })).toBeVisible();
    await shot(page, '6-a3');

    // Real effect: the clone, the row, the audit entry; the leftover folder is untouched.
    const [row] = await db.select().from(projects).where(eq(projects.githubFullName, FULL_NAME));
    expect(row).toMatchObject({ name: projectName, status: 'ready', path: suggested, currentBranch: BRANCH });
    expect(row!.commands).toMatchObject({ install: INSTALL, dev: 'npm run dev', build: 'npm run build' });
    expect(git(suggested, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH);
    expect(git(suggested, ['rev-parse', 'HEAD'])).toBe(git(repo.bare, ['rev-parse', `refs/heads/${BRANCH}`]));
    expect(git(suggested, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(path.join(suggested, 'CLAUDE.md'), 'utf8')).toContain('Site vitrine');
    expect(readdirSync(leftover)).toEqual(['brouillon.txt']);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, 'project.created'), eq(auditLog.targetId, row!.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ fullName: FULL_NAME, path: suggested, branch: BRANCH });

    // ---------------------------------------------------------------- 6. Project page D04 / M04: real data from the clone
    await flow.getByRole('link', { name: 'Voir le projet' }).click();
    await expect(page).toHaveURL(new RegExp(`/projets/${row!.id}$`), { timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 1, name: projectName }).locator('visible=true')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('dialog', { name: 'Ajouter un projet' })).toBeHidden();
    await expect(page.getByRole('button', { name: `Branche courante : ${BRANCH}. Changer de branche` }).locator('visible=true')).toBeVisible();
    await shot(page, '7-projet');

    // Branches (desktop tab; M04: the branch selector sheet).
    if (isMobile()) {
      await page.getByRole('button', { name: `Branche courante : ${BRANCH}. Changer de branche` }).locator('visible=true').click();
      const sheet = page.getByRole('dialog', { name: /^Branches/ });
      await expect(sheet.getByRole('button', { name: new RegExp(BRANCH) })).toBeVisible();
      await expect(sheet.getByText('Courante', { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
    } else {
      await page.getByRole('tab', { name: /^Branches/ }).click();
      await expect(page).toHaveURL(/onglet=branches/);
      const branches = page.getByRole('region', { name: 'Branches' }).or(page.locator('section[aria-label="Branches"]'));
      await expect(branches.getByText(BRANCH, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
      await expect(branches.getByText('main', { exact: true }).first()).toBeVisible();
    }

    // Commands (Environnement) and CLAUDE.md, as read from the clone.
    await page.getByRole('tab', { name: 'Environnement' }).locator('visible=true').click();
    await expect(page).toHaveURL(/onglet=environnement/);
    await expect(visible(page, 'section[aria-label="Environnement"]').getByText(INSTALL, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(visible(page, 'section[aria-label="Environnement"]').getByText(row!.commands.build!, { exact: true }).first()).toBeVisible();
    await page.getByRole('tab', { name: 'CLAUDE.md' }).locator('visible=true').click();
    await expect(page).toHaveURL(/onglet=claude-md/);
    await expect(visible(page, 'section[aria-label="CLAUDE.md"]').getByText('HTML sémantique, CSS sans framework.', { exact: false })).toBeVisible({ timeout: 30_000 });
    await shot(page, '8-claude-md');

    // ---------------------------------------------------------------- 7. New session → Workspace on a real worktree
    const instruction = await cli.script(`parcours-1-${device()}`, {
      description: 'Lecture des consignes du site vitrine',
      steps: [{ say: 'Je lis les consignes du dépôt.' }, { read: 'CLAUDE.md' }, { final: 'Les consignes du site vitrine sont lues : HTML sémantique, CSS sans framework.' }],
    });
    await page.getByRole('button', { name: 'Ouvrir le Workspace' }).locator('visible=true').click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle session' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/sessions? actives? sur \d+ possibles?/)).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole('combobox').filter({ hasText: projectName })).toBeVisible();
    const title = `Relecture du site · ${device()}`;
    await dialog.getByLabel('Titre').fill(title);
    const branchField = dialog.getByLabel('Nom de la nouvelle branche');
    await expect(branchField).toHaveValue(/^feature\/relecture-du-site/);
    const sessionBranch = `feature/relecture-${device()}-${Date.now().toString(36)}`;
    await branchField.fill(sessionBranch);
    await dialog.getByLabel('Première instruction').fill(instruction);
    await shot(page, '9-nouvelle-session');
    await dialog.getByRole('button', { name: 'Créer et envoyer' }).click();

    await page.waitForURL(/\/workspace\/[0-9a-f-]{36}/, { timeout: 120_000 });
    sessionId = page.url().split('/workspace/')[1]!.split(/[?#]/)[0]!;
    await expect(page.getByText('Les consignes du site vitrine sont lues : HTML sémantique, CSS sans framework.')).toBeVisible({ timeout: 120_000 });
    const session = await waitForSessionStatus(sessionId, 'waiting_input', { timeoutMs: 120_000 });
    await expect(page.getByRole('log').getByText('CLAUDE.md').first()).toBeVisible();
    await shot(page, '10-workspace');

    // Real effect: a dedicated worktree of the new clone, on the new branch, CLI alive in it.
    expect(session).toMatchObject({ projectId: row!.id, title, live: true });
    expect(session.worktree?.branch).toBe(sessionBranch);
    const worktreePath = session.worktree!.path;
    expect(path.resolve(worktreePath).startsWith(path.join(root, '.worktrees') + path.sep)).toBe(true);
    expect(git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(sessionBranch);
    expect(git(suggested, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${worktreePath}`);
    const sessionAudit = await db.select().from(auditLog).where(and(eq(auditLog.action, 'session.create'), eq(auditLog.targetId, sessionId)));
    expect(sessionAudit).toHaveLength(1);
    expect(sessionAudit[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(started.getTime() - 1000);
  } finally {
    if (sessionId) await runnerApi('stopSession', { params: { sessionId }, body: { force: true } }).catch(() => undefined);
  }
});
