import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { createDb } from '@nuera/db';
import { auditLog, commandRuns, pullRequests } from '@nuera/db/schema';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { README_NEW, README_OLD } from './harness/scenarios';
import { E2E_DATABASE_URL, E2E_STACK_DIR, expect, hideNextDevIndicator, stackRunnerApi, test, type CliHelpers, type SessionDto } from './fixtures';

/**
 * PARCOURS 3 — « Modifications → diff → vérifications (tests) → commit → push → pull request »,
 * driven through the UI like the owner would (desktop W4 / W5, phone S2 / S3), against the stack's
 * REAL runner, real Git worktrees of Devis Express and Catalogue produits, the bare « GitHub »
 * remotes, the fake GitHub (pull requests) and the stack's database (runs, pull requests, audit).
 *
 *   E2E_STACK=parcours3 pnpm --filter @nuera/web e2e parcours-3-commit-pr.spec.ts
 *
 * Every session a test creates is stopped at the end (the seeds keep 3 CLIs alive, limit 8).
 */
test.describe.configure({ mode: 'default' });

const database = createDb(E2E_DATABASE_URL, { max: 1, applicationName: 'e2e-parcours-3' });
const created: string[] = [];

test.afterAll(async () => {
  const api = await stackRunnerApi();
  while (created.length > 0) {
    const sessionId = created.pop()!;
    const session = await api('getSession', { params: { sessionId } }).catch(() => null);
    if (session?.live) await api('stopSession', { params: { sessionId }, body: { force: true } }).catch(() => undefined);
  }
  await database.$client.end({ timeout: 5 });
});

const isMobile = () => test.info().project.name === 'mobile';
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** Tip of a branch of the bare « GitHub » remote (null when the branch does not exist there). */
function remoteSha(bare: string, branch: string): string | null {
  const out = spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : null;
}

/** Pull requests the fake GitHub received (its persisted state, `github/fake-state.json`). */
function fakeGithubPulls(): Array<{ repo: string; number: number; title?: string; head?: { ref?: string }; base?: { ref?: string }; state?: string }> {
  const file = path.join(E2E_STACK_DIR, 'github', 'fake-state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { pulls?: unknown[] };
  return (raw.pulls ?? []) as ReturnType<typeof fakeGithubPulls>;
}

async function openWorkspace(page: Page, sessionId: string, query = '') {
  await page.goto(`/workspace/${sessionId}${query}`);
  await expect(page.getByRole('log', { name: 'Fil de la session' }).or(page.getByRole('tablist', { name: 'Onglets du Workspace' }))).toBeVisible({ timeout: 120_000 });
  await hideNextDevIndicator(page);
}

/** A Devis Express session whose (fake) Claude leaves three uncommitted files: two added, one modified. */
async function sessionWithChanges(cli: CliHelpers, u: string): Promise<{ session: SessionDto; files: string[] }> {
  const files = [`docs/parcours-${u}.md`, 'README.md', `src/parcours-${u}.js`];
  const session = await cli.createSession({ title: `Parcours 3 ${u}`, branch: `feature/parcours-3-${u}`, permissionMode: 'acceptEdits' });
  created.push(session.id);
  const instruction = `${await cli.script(`parcours-3-${u}`, {
    description: 'Parcours 3 : trois fichiers modifiés, non commités.',
    steps: [
      { write: { file: files[2]!, content: `export const parcours = '${u}';\n` } },
      { write: { file: files[0]!, content: `# Parcours ${u}\n\nNote du parcours 3.\n` } },
      { edit: { file: 'README.md', old: README_OLD, new: README_NEW } },
      { final: 'Les trois fichiers sont prêts, rien n\'est commité.' },
    ],
  })} Prépare les fichiers du parcours 3.`;
  await cli.sendInstruction(session.id, instruction);
  const after = await cli.waitForTurn(session.id, instruction);
  return { session: after, files: [...files].sort() };
}

test('Parcours complet : diff, index, tests, commit, push et pull request ; push direct sur la branche par défaut refusé', async ({ page, stack, runnerApi, cli }) => {
  test.setTimeout(10 * 60_000);
  const devis = stack.seeded.projects!.devis!;
  const catalogue = stack.seeded.projects!.catalogue!;
  const bare = stack.repos.find((repo) => repo.fullName === devis.fullName)!.bare;
  const ownerId = stack.owner.userId!;
  const startedAt = new Date();
  const u = unique();
  const mobile = isMobile();

  const { session, files } = await sessionWithChanges(cli, u);
  const worktree = session.worktree!;
  const branch = worktree.branch;
  expect(git(worktree.path, 'status', '--porcelain').split('\n')).toHaveLength(3);
  expect(remoteSha(bare, branch)).toBeNull();

  // --- 1. Diff: W4 review mode on desktop, Diff tab (S2) on the phone; page through the files.
  if (mobile) {
    await openWorkspace(page, session.id, '?onglet=diff');
    await expect(page.getByRole('tab', { name: /Diff/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText(/1 sur 3/).first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Fichier suivant' }).click();
    await expect(page.getByText(/2 sur 3/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Fichier suivant' }).click();
    await expect(page.getByText(/3 sur 3/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fichier suivant' })).toBeDisabled();
    await page.getByRole('button', { name: 'Fichier précédent' }).click();
    await expect(page.getByText(/2 sur 3/).first()).toBeVisible();
    // No horizontal scroll at 390 px.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  } else {
    await openWorkspace(page, session.id, '?panneau=modifications');
    const panel = page.getByRole('complementary', { name: 'Panneau contextuel' });
    await expect(panel.getByText('3 fichiers modifiés')).toBeVisible({ timeout: 60_000 });

    // Stage / unstage the README from the Modifications panel (real `git add` / `git restore --staged`).
    await panel.getByRole('button', { name: /README\.md/ }).click();
    await expect(panel.getByText('Non indexé', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Indexer', exact: true }).click();
    await expect(panel.getByText('Indexé', { exact: true })).toBeVisible();
    expect(git(worktree.path, 'diff', '--cached', '--name-only')).toBe('README.md');
    await panel.getByRole('button', { name: "Retirer de l'index" }).click();
    await expect(panel.getByText('Non indexé', { exact: true })).toBeVisible();
    expect(git(worktree.path, 'diff', '--cached', '--name-only')).toBe('');

    // W4: full-width review, file by file (buttons and the J / K keys).
    await page.goto(`/workspace/${session.id}?revue=1`);
    const review = page.getByRole('region', { name: 'Revue des modifications' });
    await expect(review.getByRole('heading', { name: /^Modifications · 3 fichiers · / })).toBeVisible({ timeout: 60_000 });
    await expect(review.getByText(/^Fichier 1 sur 3/)).toBeVisible();
    await review.getByRole('button', { name: 'Suivant · J' }).click();
    await expect(review.getByText(/^Fichier 2 sur 3/)).toBeVisible();
    await page.keyboard.press('j');
    await expect(review.getByText(/^Fichier 3 sur 3/)).toBeVisible();
    await expect(review.getByRole('button', { name: 'Suivant · J' })).toBeDisabled();
    await page.keyboard.press('k');
    await expect(review.getByText(/^Fichier 2 sur 3/)).toBeVisible();
    await review.getByRole('navigation', { name: 'Fichiers modifiés' }).getByRole('button', { name: /README\.md/ }).click();
    await expect(review.getByText('## Export CSV').first()).toBeVisible();
    await expect(page).toHaveURL(/fichier=README\.md/);
    await review.getByRole('button', { name: 'Retour à la session' }).click();
    await expect(review).toHaveCount(0);
  }

  // --- 2. Checks: the project's tests, passing on Devis Express, failing (honestly) on Catalogue produits.
  const latestTestRun = async (projectId: string) =>
    (
      await database
        .select()
        .from(commandRuns)
        .where(and(eq(commandRuns.projectId, projectId), eq(commandRuns.kind, 'test'), gt(commandRuns.startedAt, startedAt)))
        .orderBy(desc(commandRuns.startedAt))
        .limit(1)
    )[0];
  if (mobile) {
    // The phone Workspace has no Tests tab (M05): tests run from the project's Environnement card (M04).
    await page.goto(`/projets/${devis.id}`);
    await hideNextDevIndicator(page);
    await page.getByRole('button', { name: 'Lancer Tests' }).click();
    await expect.poll(async () => (await latestTestRun(devis.id))?.status, { timeout: 120_000 }).toBe('succeeded');
    await expect(page.getByText(/^13 \/ 13/).filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 });

    await page.goto(`/projets/${catalogue.id}`);
    await hideNextDevIndicator(page);
    await page.getByRole('button', { name: 'Lancer Tests' }).click();
    await expect.poll(async () => (await latestTestRun(catalogue.id))?.status, { timeout: 120_000 }).toBe('failed');
    await expect(page.getByText('1 échec', { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 });
    // The failure, honestly: the Environnement tab shows the failed run and its real output (failing test included).
    const failing = (await latestTestRun(catalogue.id))!.details?.report?.tests.filter((t) => t.status === 'failed') ?? [];
    expect(failing).toHaveLength(1);
    await page.getByRole('tab', { name: 'Environnement' }).click();
    await expect(page.getByText('npm run test a échoué').filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Voir la sortie complète' }).filter({ visible: true }).first().click();
    const output = page.getByRole('dialog', { name: 'Sortie de la commande' });
    await expect(output.getByText(failing[0]!.name.split(' > ').pop()!).first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
  } else {
    await openWorkspace(page, session.id, '?panneau=tests');
    const panel = page.getByRole('complementary', { name: 'Panneau contextuel' });
    await expect(panel.getByRole('heading', { name: 'Aucun test lancé dans ce worktree' })).toBeVisible({ timeout: 60_000 });
    await panel.getByRole('button', { name: 'Lancer les tests' }).click();
    await expect(panel.getByText('Réussis', { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(panel.getByText('réussis', { exact: true })).toBeVisible();
    const passed = await latestTestRun(devis.id);
    expect(passed).toMatchObject({ status: 'succeeded', worktreeId: worktree.id, exitCode: 0 });

    // Catalogue produits: a session on a new worktree (CLI not started), its Tests panel.
    const other = await cli.createSession({ project: 'catalogue', title: `Parcours 3 catalogue ${u}`, branch: `test/parcours-3-${u}` });
    created.push(other.id);
    await openWorkspace(page, other.id, '?panneau=tests');
    await panel.getByRole('button', { name: 'Lancer les tests' }).click();
    await expect(panel.getByText('Échec', { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(panel.getByText('échec', { exact: true })).toBeVisible();
    const failed = await latestTestRun(catalogue.id);
    expect(failed).toMatchObject({ status: 'failed', worktreeId: other.worktree!.id });
    const failing = failed!.details?.report?.tests.filter((t) => t.status === 'failed') ?? [];
    expect(failing).toHaveLength(1);
    // The failing test is listed first, marked « en échec », with its failure excerpt.
    await expect(panel.getByRole('listitem').filter({ hasText: failing[0]!.name }).first()).toContainText('en échec');
    await expect(panel.locator('pre').filter({ hasText: failing[0]!.name }).first()).toBeVisible();
  }

  // --- 3. Commit, push and pull request (W5 dialog on desktop, S3 Git tab on the phone).
  const message = `feat: parcours 3 ${u}`;
  let prNumber: number;
  if (mobile) {
    await openWorkspace(page, session.id, '?onglet=git');
    await expect(page.getByText('3 fichiers à committer')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('checkbox', { name: `Inclure ${files[0]}` }).click();
    await expect(page.getByText('2 fichiers à committer')).toBeVisible();
    await page.getByRole('checkbox', { name: `Inclure ${files[0]}` }).click();
    await expect(page.getByText('3 fichiers à committer')).toBeVisible();
    await page.getByLabel('Message de commit').fill(message);
    await expect(page.getByRole('switch', { name: 'Ouvrir une pull request' })).toBeChecked();
    await page.getByRole('button', { name: 'Committer et pousser' }).click();
    const toast = page.getByText(/^Pull request #\d+ ouverte vers main$/);
    await expect(toast).toBeVisible({ timeout: 120_000 });
    prNumber = Number((await toast.textContent())!.match(/#(\d+)/)![1]);
    // The Git tab now shows the open pull request and its link.
    await expect(page.getByText(`Pull request #${prNumber} déjà ouverte : le push la met à jour.`)).toBeVisible({ timeout: 30_000 });
  } else {
    await openWorkspace(page, session.id, '?panneau=modifications');
    const panel = page.getByRole('complementary', { name: 'Panneau contextuel' });
    await panel.getByRole('button', { name: 'Préparer la pull request' }).click();
    const dialog = page.getByRole('dialog', { name: 'Préparer le commit' });
    await expect(dialog.getByText('Fichiers inclus · 3 sur 3')).toBeVisible();
    await expect(dialog.getByText('Rien n\'est envoyé sur GitHub sans cette confirmation.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Committer et ouvrir la PR' })).toBeDisabled();
    await dialog.getByLabel('Message de commit').fill(message);
    await dialog.getByLabel('Description du commit').fill('Trois fichiers du parcours 3.');
    await expect(dialog.getByLabel('Titre de la pull request')).toHaveValue(message);
    await dialog.getByRole('button', { name: 'Committer et ouvrir la PR' }).click();
    const toast = page.getByText(/^Pull request #\d+ ouverte vers main$/);
    await expect(toast).toBeVisible({ timeout: 120_000 });
    await expect(dialog).toHaveCount(0);
    prNumber = Number((await toast.textContent())!.match(/#(\d+)/)![1]);
    // The Git actions now lead to the open pull request (W5 toast gone or not), also after a reload.
    await expect(panel.getByRole('link', { name: `Pull request #${prNumber}` })).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(panel.getByRole('link', { name: `Pull request #${prNumber}` })).toBeVisible({ timeout: 60_000 });
  }

  // Real effects: the commit (owner as author) on the branch of the bare remote, the PR on the fake GitHub, DB rows, audit.
  const head = git(worktree.path, 'rev-parse', 'HEAD');
  expect(git(worktree.path, 'log', '-1', '--format=%s|%an')).toBe(`${message}|${stack.owner.name}`);
  expect(git(worktree.path, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(files);
  expect(git(worktree.path, 'status', '--porcelain')).toBe('');
  expect(remoteSha(bare, branch)).toBe(head);
  expect(fakeGithubPulls().find((pull) => pull.repo === 'devis-express' && pull.number === prNumber)).toBeTruthy();
  const [row] = await database.select().from(pullRequests).where(and(eq(pullRequests.projectId, devis.id), eq(pullRequests.number, prNumber)));
  expect(row).toMatchObject({ headBranch: branch, baseBranch: 'main', state: 'open', sessionId: session.id, title: message });
  await expect(page.locator(`a[href="${row!.url}"]`).filter({ visible: true }).first()).toHaveText(mobile ? 'Voir sur GitHub' : `Pull request #${prNumber}`);
  const audits = await database
    .select({ action: auditLog.action, metadata: auditLog.metadata, actor: auditLog.actorUserId })
    .from(auditLog)
    .where(and(inArray(auditLog.action, ['git.commit', 'git.push', 'github.pull_request']), gt(auditLog.createdAt, startedAt)));
  const mine = audits.filter((a) => (a.metadata as { worktreeId?: string } | null)?.worktreeId === worktree.id);
  expect(mine.map((a) => a.action).sort()).toEqual(['git.commit', 'git.push', 'github.pull_request']);
  expect(mine.every((a) => a.actor === ownerId)).toBe(true);
  expect(mine.find((a) => a.action === 'git.commit')!.metadata).toMatchObject({ sha: head, sessionId: session.id });

  // --- 4. Push to the protected default branch: refused, T4 panel, nothing sent.
  if (!mobile) {
    // Claude (or the owner, in the terminal) switched the worktree to main: the runner refuses the push.
    const remoteMain = remoteSha(bare, devis.defaultBranch);
    const stray = path.join(worktree.path, `notes-${u}.txt`);
    git(worktree.path, 'checkout', '--quiet', '--ignore-other-worktrees', devis.defaultBranch);
    writeFileSync(stray, 'brouillon\n');
    try {
      await openWorkspace(page, session.id, '?panneau=modifications');
      const panel = page.getByRole('complementary', { name: 'Panneau contextuel' });
      await expect(panel.getByText('1 fichier modifié')).toBeVisible({ timeout: 60_000 });
      await panel.getByRole('button', { name: 'Préparer le commit' }).click();
      const dialog = page.getByRole('dialog', { name: 'Préparer le commit' });
      await dialog.getByRole('checkbox', { name: `Inclure notes-${u}.txt` }).click();
      await dialog.getByRole('switch', { name: /^Pousser sur origin/ }).click();
      await dialog.getByRole('button', { name: 'Pousser', exact: true }).click();
      await expect(dialog.getByText("Le push vers GitHub n'a pas abouti")).toBeVisible({ timeout: 60_000 });
      await expect(dialog.getByText("Cette branche est protégée : elle évolue par pull request, jamais par un push direct.")).toBeVisible();
      await expect(dialog.getByText("Rien n'a été envoyé sur GitHub.")).toBeVisible();
      await dialog.getByRole('button', { name: 'Annuler' }).click();
      expect(remoteSha(bare, devis.defaultBranch)).toBe(remoteMain);
    } finally {
      rmSync(stray, { force: true });
      git(worktree.path, 'checkout', '--quiet', branch);
    }
  }

  await runnerApi('stopSession', { params: { sessionId: session.id }, body: { force: true } }).catch(() => undefined);
});
