import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { createDb } from '@nuera/db';
import { auditLog, permissionRequests } from '@nuera/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { E2E_DATABASE_URL, expect, hideNextDevIndicator, samePath, stackRunnerApi, test, type FakeCliScript } from './fixtures';

/**
 * PARCOURS 2 — « Projet → branche / worktree → session → instruction → suivi en direct →
 * autorisation ou erreur → résultat », driven through the UI like the owner would (desktop D05 and
 * phone M05), against the stack's REAL runner (pty backend, TEST-ONLY fake CLI), real git worktrees
 * of Devis Express and the stack's database (permission rows, audit log).
 *
 *   E2E_STACK=parcours2 pnpm --filter @nuera/web e2e parcours-2-session-en-direct.spec.ts
 *
 * Every session a test creates is stopped at the end (the seeds keep 3 CLIs alive, limit 8).
 */
test.describe.configure({ mode: 'default' });

const database = createDb(E2E_DATABASE_URL, { max: 1, applicationName: 'e2e-parcours-2' });
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
  // Same bytes as the runner (core.autocrlf=false): Git for Windows turns autocrlf on system-wide.
  return execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' }).trim();
}

/** Whether the bare « GitHub » remote has this branch (nothing is pushed by this flow). */
function remoteHasBranch(bare: string, branch: string): boolean {
  return spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8' }).status === 0;
}

const field = (page: Page) => page.getByRole('textbox', { name: 'Instruction pour Claude' });
const thread = (page: Page) => page.getByRole('log', { name: 'Fil de la session' });
/** Header badge (D05 `En-tête de session` / M05 `État de la session`). */
const statusBadge = (page: Page, text: string | RegExp) => page.getByText(text, typeof text === 'string' ? { exact: true } : undefined).first();

/** The owner types in the composer: Enter on desktop, « Envoyer » on the phone. */
async function sendFromComposer(page: Page, text: string) {
  const input = field(page);
  await expect(input).not.toHaveAttribute('readonly', '');
  await input.fill(text);
  if (isMobile()) await page.getByRole('button', { name: 'Envoyer' }).click();
  else await input.press('Enter');
  await expect(thread(page).getByText(text)).toBeVisible({ timeout: 60_000 });
}

async function openWorkspace(page: Page, sessionId: string, hash = '') {
  await page.goto(`/workspace/${sessionId}${hash}`);
  await expect(thread(page)).toBeVisible({ timeout: 120_000 });
  await hideNextDevIndicator(page);
}

async function installScript(cli: { script: (name: string, script: FakeCliScript) => Promise<string> }, name: string, script: FakeCliScript, sentence: string) {
  return `${await cli.script(name, script)} ${sentence}`;
}

/** Plain text of the xterm screen (DOM renderer rows). */
function terminalRows(page: Page): Locator {
  return page.locator('[data-terminal-state] .xterm-rows');
}

test('Parcours complet : nouvelle branche et worktree, session, suivi en direct, autoriser puis refuser, résultat', async ({ page, stack, runnerApi, cli, waitForSessionStatus }) => {
  test.setTimeout(8 * 60_000);
  const devis = stack.seeded.projects!.devis!;
  const bare = stack.repos.find((repo) => repo.fullName === devis.fullName)!.bare;
  const u = unique();
  const title = `Parcours 2 ${u}`;
  const branch = `test/parcours-2-${u}`;
  const note = `docs/parcours-${u}.md`;
  const command = `npm run test -- parcours-${u}`;

  // --- 1. From the project page, « Nouvelle session » with a new branch (worktree created by the runner).
  await page.goto(`/projets/${devis.id}`);
  await expect(page.getByRole('heading', { name: devis.name, level: 1 }).filter({ visible: true }).first()).toBeVisible({ timeout: 120_000 });
  await hideNextDevIndicator(page);
  // « … » of the project header: a menu on desktop (D04), a sheet on the phone (M04).
  await page.getByRole('button', { name: 'Actions du projet' }).filter({ visible: true }).first().click();
  if (isMobile()) await page.getByRole('dialog', { name: devis.name }).getByRole('button', { name: 'Nouvelle session ici' }).click();
  else await page.getByRole('menuitem', { name: 'Nouvelle session ici' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nouvelle session' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/sessions? actives? sur \d+ possibles?/)).toBeVisible({ timeout: 30_000 });
  await dialog.getByLabel('Titre').fill(title);
  const branchField = dialog.getByLabel('Nom de la nouvelle branche');
  await branchField.fill(branch);
  await expect(dialog.getByText(`Worktree parcours-2-${u} créé depuis ${devis.defaultBranch}.`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Créer la session' }).click();
  await page.waitForURL(/\/workspace\/[0-9a-f-]{36}/, { timeout: 120_000 });
  const sessionId = page.url().split('/workspace/')[1]!.split(/[?#]/)[0]!;
  created.push(sessionId);

  // Real effect: a new worktree on the new branch, from the default branch, nothing pushed.
  const fresh = await runnerApi('getSession', { params: { sessionId } });
  expect(fresh).toMatchObject({ title, status: 'new', permissionMode: 'manual', projectId: devis.id });
  const worktree = fresh.worktree!;
  expect(worktree).toMatchObject({ branch, name: `parcours-2-${u}`, baseBranch: devis.defaultBranch, isPrimary: false });
  expect(git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
  // The runner starts a new worktree from origin/<base> when it exists (local commits of the clone
  // — e.g. a CLAUDE.md committed from the project page by an earlier test — stay out of it).
  expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(git(devis.path, 'rev-parse', `refs/remotes/origin/${devis.defaultBranch}`));
  // `git worktree list` prints `P:/…` where the DTO holds `P:\…` on Windows.
  const listed = git(devis.path, 'worktree', 'list', '--porcelain')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  expect(listed.some((item) => samePath(item, worktree.path))).toBe(true);
  expect(remoteHasBranch(bare, branch)).toBe(false);

  await expect(page.getByRole('heading', { name: 'Claude Code est prêt dans devis-express' })).toBeVisible({ timeout: 60_000 });
  await expect(statusBadge(page, 'Prête')).toBeVisible();

  // --- 2. Instruction from the composer, followed live.
  const instruction = await installScript(
    cli,
    `parcours2-a-${u}`,
    {
      description: 'Lecture, étape longue, une écriture et une commande soumises à autorisation',
      denied: "D'accord, je ne lance pas les tests : dites-moi comment vous préférez vérifier la note.",
      steps: [
        { plan: [{ content: 'Lire le calcul des totaux', status: 'in_progress', activeForm: 'Lecture du calcul des totaux' }, { content: 'Ajouter la note de parcours', status: 'pending' }, { content: 'Lancer les tests', status: 'pending' }] },
        { say: 'Je lis le calcul des totaux avant de toucher au dépôt.' },
        { read: 'src/devis.js' },
        { wait: { command: 'npm run lint', description: 'Vérifie le style du dépôt.', seconds: 8, every: 1, output: ['src/devis.js : aucun problème'] } },
        { write: { file: note, content: '# Parcours\n\nNote ajoutée par la session de parcours.\n' } },
        { bash: { command, description: 'Lance la suite de tests du devis.', output: 'Tests  13 passed (13)' }, ask: true },
        { final: 'La note est ajoutée et les tests passent.' },
      ],
    },
    'Ajoute une note de parcours puis lance les tests.',
  );
  await sendFromComposer(page, instruction);

  // While it runs: « En cours » in the header, tool lines appear one after the other.
  await waitForSessionStatus(sessionId, 'running', { timeoutMs: 60_000 });
  await expect(statusBadge(page, /^En cours · /)).toBeVisible({ timeout: 30_000 });
  const log = thread(page);
  await expect(log.getByText('Lire le calcul des totaux')).toBeVisible({ timeout: 30_000 });
  await expect(log.getByText('Je lis le calcul des totaux avant de toucher au dépôt.')).toBeVisible();
  await expect(log.getByText('src/devis.js', { exact: true })).toBeVisible();
  const lint = log.locator('div').filter({ hasText: /^En cours :\s*Bash\s*npm run lint/ }).last();
  await expect(lint).toBeVisible({ timeout: 30_000 });
  await expect(lint).toContainText(/en cours/);
  expect((await runnerApi('getSession', { params: { sessionId } })).status).toBe('running');

  // --- 3. First permission (Write), answered « Autoriser » on the Workspace card.
  const first = await cli.waitForPermission(sessionId, 90_000);
  expect(first).toMatchObject({ toolName: 'Write', title: 'Claude demande à modifier un fichier' });
  const firstCard = page.locator(`#demande-${first.id}`);
  await expect(firstCard.getByRole('heading', { name: 'Claude demande à modifier un fichier' })).toBeVisible({ timeout: 30_000 });
  await expect(firstCard).toContainText(note);
  await expect(statusBadge(page, 'Autorisation demandée')).toBeVisible();
  await expect(field(page)).toHaveAttribute('readonly', '');
  await expect(log.getByText(/^Terminé :\s*Bash\s*npm run lint/)).toHaveCount(1);
  await firstCard.getByRole('button', { name: 'Autoriser' }).click();
  await expect(log.getByText(new RegExp(`^Modification autorisée une fois · .*${note.replace(/[.]/g, '\\.')}$`))).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => existsSync(path.join(worktree.path, note)), { timeout: 30_000 }).toBe(true);
  expect(readFileSync(path.join(worktree.path, note), 'utf8')).toContain('Note ajoutée par la session de parcours.');

  // --- 4. Second permission (Bash): the bell and Sessions « Répondre » both lead to it.
  const second = await waitForSessionStatus(sessionId, 'waiting_permission', { timeoutMs: 90_000, where: (s) => s.pendingPermission !== null && s.pendingPermission.id !== first.id });
  const secondId = second.pendingPermission!.id;
  expect(second.pendingPermission).toMatchObject({ toolName: 'Bash', target: command });

  await page.goto('/');
  await hideNextDevIndicator(page);
  await page.getByRole('button', { name: /^Notifications · \d+ non lues?$/ }).filter({ visible: true }).first().click();
  // S5: « <titre de la session> attend votre accord » (same wording as the Web Push title).
  // Both requests of the session carry that title: the Bash one is the link to its request.
  const notice = page.getByRole('link', { name: `${title} attend votre accord` }).and(page.locator(`[href$="#demande-${secondId}"]`));
  await expect(notice).toHaveAttribute('href', `/workspace/${sessionId}#demande-${secondId}`);
  await notice.click();
  await page.waitForURL(new RegExp(`/workspace/${sessionId}#demande-${secondId}$`), { timeout: 60_000 });
  await expect(page.locator(`#demande-${secondId}`).getByRole('heading', { name: 'Claude demande à exécuter une commande' })).toBeInViewport({ timeout: 60_000 });

  await page.goto('/sessions');
  await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toBeVisible({ timeout: 120_000 });
  const card = page.locator(`[data-session-card="${sessionId}"]:visible`);
  await expect(card).toContainText('Autorisation demandée');
  const reply = card.getByRole('link', { name: 'Répondre' });
  await expect(reply).toHaveAttribute('href', `/workspace/${sessionId}#demande-${secondId}`);
  await reply.click();
  await page.waitForURL(new RegExp(`/workspace/${sessionId}#demande-${secondId}$`), { timeout: 60_000 });
  await hideNextDevIndicator(page);
  const secondCard = page.locator(`#demande-${secondId}`);
  await expect(secondCard).toBeInViewport({ timeout: 60_000 });
  await expect(secondCard).toContainText(`$ ${command}`);
  await expect(secondCard).toContainText('Lance la suite de tests du devis.');

  // « Refuser »: Claude is told, the turn ends; the owner then tells it what to do instead.
  await secondCard.getByRole('button', { name: 'Refuser' }).click();
  await expect(thread(page).getByText('Commande refusée · Claude a été prévenu')).toBeVisible({ timeout: 30_000 });
  await expect(thread(page).getByText("D'accord, je ne lance pas les tests : dites-moi comment vous préférez vérifier la note.")).toBeVisible({ timeout: 60_000 });
  await waitForSessionStatus(sessionId, 'waiting_input', { timeoutMs: 60_000 });
  await expect(statusBadge(page, "En attente d'instruction")).toBeVisible({ timeout: 30_000 });

  const followUp = await installScript(
    cli,
    `parcours2-b-${u}`,
    {
      description: 'Relecture de la note sans lancer les tests',
      steps: [{ say: 'Je relis seulement la note, sans lancer la suite.' }, { read: note }, { final: `Compris : je ne lance pas la suite. La note ${note} est prête à être relue.` }],
    },
    'Ne lance pas la suite complète : relis seulement la note.',
  );
  await sendFromComposer(page, followUp);

  // --- 5. Result: final message, changed files counted in the panel, session « En attente ».
  await expect(thread(page).getByText(`Compris : je ne lance pas la suite. La note ${note} est prête à être relue.`)).toBeVisible({ timeout: 90_000 });
  await cli.waitForTurn(sessionId, followUp, 60_000);
  await expect(statusBadge(page, "En attente d'instruction")).toBeVisible({ timeout: 30_000 });
  if (isMobile()) {
    await page.getByRole('tab', { name: 'Diff · 1' }).click();
    await expect(page.getByText('1 sur 1 · +3')).toBeVisible({ timeout: 30_000 });
  } else {
    const changesTab = page.getByRole('tab', { name: 'Modifications · 1' });
    await expect(changesTab).toBeVisible({ timeout: 30_000 });
    await changesTab.click();
    await expect(page.getByRole('complementary', { name: 'Panneau contextuel' }).getByText(note.split('/').pop()!).first()).toBeVisible();
  }
  expect(git(worktree.path, 'status', '--porcelain')).toBe(`?? ${note}`);
  const changes = await runnerApi('worktreeChanges', { params: { worktreeId: worktree.id } });
  expect(changes.totals.files).toBe(1);
  expect(remoteHasBranch(bare, branch)).toBe(false);

  // --- 6. The decisions are recorded (runner rows) and audited (security journal).
  const rows = await database
    .select({ id: permissionRequests.id, status: permissionRequests.status, decidedBy: permissionRequests.decidedByUserId })
    .from(permissionRequests)
    .where(inArray(permissionRequests.id, [first.id, secondId]));
  expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({ [first.id]: 'allowed', [secondId]: 'denied' });
  expect(rows.every((row) => row.decidedBy === stack.owner.userId)).toBe(true);
  const audits = await database
    .select({ summary: auditLog.summary, metadata: auditLog.metadata, actor: auditLog.actorUserId, targetId: auditLog.targetId })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'permission.decision'), eq(auditLog.targetId, sessionId)));
  const byPermission = new Map(audits.map((entry) => [entry.metadata?.permissionId, entry]));
  expect(byPermission.get(first.id)).toMatchObject({ actor: stack.owner.userId, metadata: { decision: 'allow', status: 'allowed', tool: 'Write' } });
  expect(byPermission.get(first.id)!.summary).toMatch(new RegExp(`^« autoriser une fois » .*${note.replace(/[.]/g, '\\.')} · ${devis.name}$`));
  expect(byPermission.get(secondId)).toMatchObject({ summary: `« refuser » ${command} · ${devis.name}`, metadata: { decision: 'deny', status: 'denied', tool: 'Bash' } });

  if (!isMobile()) {
    await page.goto('/parametres?onglet=compte-et-securite#journal-de-securite');
    const journal = page.getByRole('region', { name: 'Journal de sécurité' });
    await expect(journal.getByText(`« refuser » ${command} · ${devis.name}`)).toBeVisible({ timeout: 120_000 });
  }
});

test('Erreur montrée telle quelle : commande en échec puis limite d\'utilisation du CLI', async ({ page, runnerApi, cli, waitForSessionStatus }) => {
  test.setTimeout(5 * 60_000);
  const u = unique();
  const session = await cli.createSession({ title: `Compilation ${u}`, branch: `test/parcours-2-erreur-${u}`, permissionMode: 'acceptEdits' });
  created.push(session.id);
  await openWorkspace(page, session.id);

  const instruction = await installScript(
    cli,
    `parcours2-erreur-${u}`,
    {
      description: 'Une commande qui échoue',
      steps: [
        { say: 'Je compile le projet avant de livrer.' },
        { bash: { command: 'npm run build', description: 'Compile le projet.', output: "> devis-express build\nError: Cannot find module './tva-inconnue.js'", exitCode: 1 }, ask: false },
        { final: "La compilation échoue : le module ./tva-inconnue.js est introuvable. Je n'ai rien modifié." },
      ],
    },
    'Compile le projet.',
  );
  await sendFromComposer(page, instruction);

  const log = thread(page);
  const failed = log.getByRole('button', { name: /^Erreur :\s*Bash\s*npm run build/ });
  await expect(failed).toBeVisible({ timeout: 60_000 });
  await failed.click();
  await expect(failed).toHaveAttribute('aria-expanded', 'true');
  await expect(log.getByText("Error: Cannot find module './tva-inconnue.js'", { exact: false })).toBeVisible();
  await expect(log.getByText("La compilation échoue : le module ./tva-inconnue.js est introuvable. Je n'ai rien modifié.")).toBeVisible({ timeout: 60_000 });
  await cli.waitForTurn(session.id, instruction, 60_000);
  await expect(statusBadge(page, "En attente d'instruction")).toBeVisible({ timeout: 30_000 });
  const events = await runnerApi('sessionEvents', { params: { sessionId: session.id }, query: { afterVersion: 0 } });
  const tool = events.items.find((item) => item.kind === 'tool' && item.payload.tool === 'Bash');
  expect(tool?.kind === 'tool' ? tool.payload.status : null).toBe('error');

  // The CLI itself stops on its usage limit: the thread says so, the session stays usable.
  await sendFromComposer(page, 'scenario:limite Continue la livraison.');
  await expect(log.getByText("Limite d'utilisation atteinte : la session reprendra quand la limite sera levée.")).toBeVisible({ timeout: 60_000 });
  const limited = await waitForSessionStatus(session.id, 'waiting_input', { timeoutMs: 60_000, where: (s) => s.errorCode === 'rate_limit' });
  expect(limited.live).toBe(true);
  await expect(statusBadge(page, "En attente d'instruction")).toBeVisible({ timeout: 30_000 });
  await expect(field(page)).not.toHaveAttribute('readonly', '');
});

test('Terminal brut en direct puis Échap : l\'étape s\'arrête, la session attend', async ({ page, runnerApi, cli, waitForSessionStatus }) => {
  test.setTimeout(5 * 60_000);
  const u = unique();
  const session = await cli.createSession({ title: `Étape longue ${u}`, branch: `test/parcours-2-echap-${u}`, permissionMode: 'acceptEdits' });
  created.push(session.id);
  await openWorkspace(page, session.id);
  const marker = `suite e2e ${u} · cas suivant`;
  const instruction = await installScript(
    cli,
    `parcours2-echap-${u}`,
    {
      description: 'Étape longue à sortie continue',
      steps: [{ say: 'Je lance la suite e2e complète, elle est longue.' }, { wait: { command: 'npm run e2e', description: 'Suite e2e complète.', seconds: 300, every: 1, output: [marker] } }, { final: 'Fini.' }],
    },
    'Lance la suite e2e complète.',
  );
  await sendFromComposer(page, instruction);
  await waitForSessionStatus(session.id, 'running', { timeoutMs: 60_000 });
  await expect(statusBadge(page, /^En cours · /)).toBeVisible({ timeout: 30_000 });
  await expect(thread(page).locator('div').filter({ hasText: /^En cours :\s*Bash\s*npm run e2e/ }).last()).toBeVisible({ timeout: 30_000 });

  // « Terminal brut »: the same CLI process, streaming while the step runs.
  if (isMobile()) {
    await page.getByRole('button', { name: 'Actions de session' }).click();
    await page.getByRole('button', { name: 'Voir le terminal brut' }).click();
  } else {
    await page.getByRole('radio', { name: 'Terminal brut' }).click();
  }
  await expect(page).toHaveURL(/vue=terminal/);
  await expect(page.locator('[data-terminal-state="live"]')).toBeVisible({ timeout: 60_000 });
  const rows = terminalRows(page);
  await expect(rows).toContainText('● Bash(npm run e2e)', { timeout: 30_000 });
  await expect(rows).toContainText(marker, { timeout: 30_000 });
  const count = async () => ((await rows.textContent()) ?? '').split(marker).length - 1;
  const before = await count();
  await expect.poll(count, { timeout: 30_000 }).toBeGreaterThan(before);

  // Back to the conversation, then Échap (desktop key, phone « Interrompre · Échap »).
  if (isMobile()) {
    await page.getByRole('button', { name: 'Actions de session' }).click();
    await page.getByRole('button', { name: 'Voir la conversation' }).click();
  } else {
    await page.getByRole('radio', { name: 'Conversation' }).click();
  }
  await expect(page).not.toHaveURL(/vue=terminal/);
  await expect(thread(page)).toBeVisible();
  if (isMobile()) {
    await page.getByRole('button', { name: 'Actions de session' }).click();
    await page.getByRole('button', { name: 'Interrompre · Échap' }).click();
  } else {
    await thread(page).click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');
  }
  await waitForSessionStatus(session.id, 'waiting_input', { timeoutMs: 30_000 });
  await expect(thread(page).getByText(/Étape interrompue/)).toBeVisible({ timeout: 30_000 });
  await expect(statusBadge(page, "En attente d'instruction")).toBeVisible({ timeout: 30_000 });
  await expect(thread(page).locator('div').filter({ hasText: /^En cours :\s*Bash/ })).toHaveCount(0);
  await expect(field(page)).toHaveAttribute('placeholder', isMobile() ? /.+/ : 'Écrire une instruction à Claude…');
  const after = await runnerApi('getSession', { params: { sessionId: session.id } });
  expect(after).toMatchObject({ status: 'waiting_input', live: true, pendingPermission: null });

  // The raw terminal shows the interruption too (same PTY).
  if (isMobile()) {
    await page.getByRole('button', { name: 'Actions de session' }).click();
    await page.getByRole('button', { name: 'Voir le terminal brut' }).click();
  } else {
    await page.getByRole('radio', { name: 'Terminal brut' }).click();
  }
  await expect(terminalRows(page)).toContainText("Interrompu par l'utilisateur.", { timeout: 30_000 });
});
