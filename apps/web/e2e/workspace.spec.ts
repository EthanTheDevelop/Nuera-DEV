import type { Page } from '@playwright/test';
import { E2E_BASE_URL, expect, hideNextDevIndicator, test, type StackFixtures } from './fixtures';

/**
 * Lot WORKSPACE — /workspace/[sessionId] (D05 / M05, W1–W7, S1–S4) against the stack's REAL runner
 * (pty backend, TEST-ONLY fake CLI), real git worktrees and the fake GitHub.
 *
 *   E2E_STACK=workspace pnpm --filter @nuera/web e2e workspace.spec.ts
 *
 * Each test drives its own session (scripted fake CLI) and stops it at the end: the seeds keep
 * 3 CLIs alive and the session limit is 8.
 */
test.describe.configure({ mode: 'default' });

const isMobile = () => test.info().project.name === 'mobile';
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const created: string[] = [];

async function openWorkspace(page: Page, sessionId: string, search = '') {
  await page.goto(`/workspace/${sessionId}${search}`);
  await expect(page.getByRole('log', { name: 'Fil de la session' }).or(page.locator('[data-terminal-state]'))).toBeVisible({ timeout: 120_000 });
  await hideNextDevIndicator(page);
}

async function stopAll(runnerApi: StackFixtures['runnerApi']) {
  while (created.length > 0) {
    const sessionId = created.pop()!;
    const session = await runnerApi('getSession', { params: { sessionId } }).catch(() => null);
    if (session?.live) await runnerApi('stopSession', { params: { sessionId }, body: { force: true } }).catch(() => undefined);
  }
}

test.afterAll(async () => {
  const { stackRunnerApi } = await import('./fixtures');
  await stopAll(await stackRunnerApi());
});

test('Session inconnue → 404 « Session introuvable »', async ({ page }) => {
  await page.goto('/workspace/00000000-0000-4000-8000-000000000000');
  await expect(page.getByText('Session introuvable')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('link', { name: 'Voir les sessions' })).toHaveAttribute('href', '/sessions');
});

test('W1 · nouvelle session : état vierge, suggestion dans la saisie, premier envoi', async ({ page, cli, waitForSessionStatus }) => {
  const session = await cli.createSession({ title: `Nouvelle session ${unique()}`, branch: `test/w1-${unique()}` });
  created.push(session.id);
  const instruction = await cli.script(`w1-${unique()}`, {
    description: 'Premier tour court',
    steps: [{ say: 'Je regarde la structure du dépôt.' }, { read: 'README.md' }, { final: 'Le dépôt contient un générateur de devis.' }],
  });
  await openWorkspace(page, session.id);

  await expect(page.getByRole('heading', { name: 'Claude Code est prêt dans devis-express' })).toBeVisible();
  await expect(page.getByText(/créé depuis main/)).toBeVisible();
  await expect(page.getByText('Prête', { exact: true }).first()).toBeVisible();
  if (!isMobile()) await expect(page.getByText('La session démarre au premier envoi et continuera sans ce navigateur.')).toBeVisible();

  // Q1: a suggestion fills the composer, it is never sent by itself.
  await page.getByRole('button', { name: "Explique la structure du dépôt avant d'y toucher" }).click();
  const field = page.getByRole('textbox', { name: 'Instruction pour Claude' });
  await expect(field).toHaveValue("Explique la structure du dépôt avant d'y toucher");
  expect((await (await import('./fixtures')).stackRunnerApi().then((api) => api('getSession', { params: { sessionId: session.id } }))).status).toBe('new');

  await field.fill(instruction);
  await field.press('Enter');
  await expect(page.getByRole('log').getByText(instruction)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Le dépôt contient un générateur de devis.')).toBeVisible({ timeout: 90_000 });
  await waitForSessionStatus(session.id, 'waiting_input', { timeoutMs: 90_000 });
  await expect(page.getByRole('log').getByText('README.md')).toBeVisible();
});

test('D05 / M05 · demande d\'autorisation : carte, saisie suspendue, « Autoriser » transmis au CLI', async ({ page, cli, runnerApi }) => {
  const session = await cli.createSession({ title: `Autorisation ${unique()}`, branch: `test/d05-${unique()}`, permissionWaitSeconds: 600 });
  created.push(session.id);
  const instruction = await cli.script(`d05-${unique()}`, {
    description: 'Une commande soumise à autorisation',
    steps: [
      { say: 'Je lance la suite de tests.' },
      { bash: { command: 'npm run test -- devis', description: 'Lance la suite de tests du devis.', output: 'Tests  3 passed (3)' }, ask: true },
      { final: 'Les trois tests passent.' },
    ],
  });
  await cli.sendInstruction(session.id, instruction);
  const permission = await cli.waitForPermission(session.id);
  await openWorkspace(page, session.id);

  const card = page.locator(`#demande-${permission.id}`);
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Claude demande à exécuter une commande' })).toBeVisible();
  await expect(card).toContainText('$ npm run test -- devis');
  await expect(card).toContainText("Mode : demander avant d'agir");
  await expect(page.getByText('Autorisation demandée').first()).toBeVisible();
  const field = page.getByRole('textbox', { name: 'Instruction pour Claude' });
  await expect(field).toHaveAttribute('readonly', '');
  await expect(field).toHaveAttribute('placeholder', isMobile() ? "Répondez d'abord à la demande…" : "Répondez d'abord à la demande d'autorisation ci-dessus…");

  // The API refuses an instruction while the CLI waits (Figma reason, runner sub-code kept).
  const refused = await page.request.post(`/api/sessions/${session.id}/instruction`, { data: { text: 'Autre chose' }, headers: { origin: E2E_BASE_URL } });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toMatchObject({ reason: 'SESSION_BUSY_PERMISSION', message: "Répondez d'abord à la demande d'autorisation ci-dessus." });
  // Mutations without a same-origin Origin are refused.
  const foreign = await page.request.post(`/api/permissions/${permission.id}/decision`, { data: { optionId: 'allow' }, headers: { origin: 'https://evil.example' } });
  expect(foreign.status()).toBe(403);

  await card.getByRole('button', { name: 'Autoriser' }).click();
  await expect(page.getByText('Commande autorisée une fois · npm run test -- devis')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Les trois tests passent.')).toBeVisible({ timeout: 60_000 });
  const after = await runnerApi('getSession', { params: { sessionId: session.id } });
  expect(after.pendingPermission).toBeNull();
  await expect(field).not.toHaveAttribute('readonly', '');
});

test('W2 · instruction en file pendant une étape, Interrompre (Échap) rend la main', async ({ page, cli, waitForSessionStatus }) => {
  const session = await cli.createSession({ title: `Tâche longue ${unique()}`, branch: `test/w2-${unique()}`, permissionMode: 'acceptEdits' });
  created.push(session.id);
  const instruction = await cli.script(`w2-${unique()}`, {
    description: 'Étape longue',
    steps: [{ say: 'Je lance une étape longue.' }, { wait: { command: 'npm run e2e', seconds: 120, every: 2, output: ['… encore en cours'] } }, { final: 'Fini.' }],
  });
  await cli.sendInstruction(session.id, instruction);
  await waitForSessionStatus(session.id, 'running');
  await openWorkspace(page, session.id);

  await expect(page.getByText(/En cours · /).first()).toBeVisible();
  if (!isMobile()) {
    await expect(page.getByRole('textbox', { name: 'Instruction pour Claude' })).toHaveAttribute(
      'placeholder',
      "Ajouter une précision pour Claude, elle sera lue à la fin de l'étape en cours…",
    );
    await page.getByRole('button', { name: 'Interrompre', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Actions de session' }).click();
    await page.getByRole('button', { name: 'Interrompre · Échap' }).click();
  }
  await waitForSessionStatus(session.id, 'waiting_input', { timeoutMs: 30_000 });
  await expect(page.getByText(/Étape interrompue/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('textbox', { name: 'Instruction pour Claude' })).toHaveAttribute('placeholder', 'Écrire une instruction à Claude…');
});

test('W2 · Terminal brut : le PTY de la session dans le terminal partagé', async ({ page, stack }) => {
  test.skip(isMobile(), 'Bureau : bascule Conversation / Terminal brut de la barre de vue.');
  const sessionId = stack.seeded.sessions!.running!.id;
  await openWorkspace(page, sessionId);
  await page.getByRole('radio', { name: 'Terminal brut' }).click();
  await expect(page).toHaveURL(/vue=terminal/);
  await expect(page.locator('[data-terminal-state="live"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Flux exact du processus Claude Code, sans mise en forme.', { exact: false })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('log', { name: 'Fil de la session' })).toBeVisible();
});

test('W4 / W5 · S2 / S3 · modifications, revue, commit, push et pull request', async ({ page, cli, runnerApi }) => {
  const branch = `test/w5-${unique()}`;
  const session = await cli.createSession({ title: `Commit ${unique()}`, branch, permissionMode: 'acceptEdits' });
  created.push(session.id);
  const instruction = await cli.script(`w5-${unique()}`, {
    description: 'Deux fichiers modifiés',
    steps: [
      { write: { file: 'docs/export.md', content: '# Export\n\nUne ligne par article.\n' } },
      { write: { file: 'docs/notes.md', content: 'Notes de version.\n' } },
      { final: 'Deux fichiers ajoutés.' },
    ],
  });
  await cli.sendInstruction(session.id, instruction);
  await cli.waitForTurn(session.id, instruction);
  await openWorkspace(page, session.id);
  const title = `Docs ${unique()}`;

  if (!isMobile()) {
    await expect(page.getByRole('tab', { name: 'Modifications · 2' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('tab', { name: 'Modifications · 2' }).click();
    await expect(page.getByText('2 fichiers modifiés')).toBeVisible();
    // W4 review: J / K cross file boundaries.
    await page.getByRole('button', { name: 'Avant / après' }).click();
    await expect(page.getByRole('heading', { name: /Modifications · 2 fichiers · \+4/ })).toBeVisible();
    await expect(page.getByText('Fichier 1 sur 2 · bloc 1 sur 1')).toBeVisible();
    await page.keyboard.press('j');
    await expect(page.getByText('Fichier 2 sur 2 · bloc 1 sur 1')).toBeVisible();
    await page.getByRole('button', { name: 'Précédent · K' }).click();
    await expect(page.getByText('Fichier 1 sur 2 · bloc 1 sur 1')).toBeVisible();
    await page.getByRole('button', { name: 'Retour à la session' }).click();

    // W5 modal.
    await page.getByRole('button', { name: 'Commit et push' }).click();
    const dialog = page.getByRole('dialog', { name: 'Préparer le commit' });
    await expect(dialog).toContainText('Fichiers inclus · 2 sur 2');
    await expect(dialog.getByRole('button', { name: 'Committer et ouvrir la PR' })).toBeDisabled();
    await dialog.getByRole('checkbox', { name: 'Inclure docs/notes.md' }).click();
    await expect(dialog).toContainText('Fichiers inclus · 1 sur 2');
    await dialog.getByRole('textbox', { name: 'Message de commit' }).fill(title);
    await expect(dialog.getByRole('textbox', { name: 'Titre de la pull request' })).toHaveValue(title);
    await dialog.getByRole('button', { name: 'Committer et ouvrir la PR' }).click();
    await expect(page.getByText(/Pull request #\d+ ouverte vers main/).first()).toBeVisible({ timeout: 90_000 });
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Modifications · 1' })).toBeVisible({ timeout: 30_000 });
  } else {
    await page.getByRole('tab', { name: 'Diff · 2' }).click();
    await expect(page.getByText('1 sur 2 · +3')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Fichier suivant' }).click();
    await expect(page.getByText('2 sur 2 · +1')).toBeVisible();
    await expect(page.getByText("Une ligne coupée s'ouvre en entier au toucher.", { exact: false })).toBeVisible();
    await page.getByRole('tab', { name: 'Git' }).click();
    await expect(page.getByText('2 fichiers à committer')).toBeVisible();
    await page.getByRole('textbox', { name: 'Message de commit' }).fill(title);
    // S3: the sticky button reads « Committer et pousser » with both switches on (Figma).
    await expect(page.getByRole('switch', { name: /Ouvrir une pull request/ })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Committer et pousser' })).toBeEnabled();
    await page.getByRole('switch', { name: /Ouvrir une pull request/ }).click();
    await page.getByRole('button', { name: 'Committer et pousser' }).click();
    await expect(page.getByText(/Commit [0-9a-f]{7} poussé sur origin\//).first()).toBeVisible({ timeout: 90_000 });
  }

  const log = await runnerApi('repoLog', { params: { projectId: session.projectId }, query: { worktreeId: session.worktreeId!, n: 1 } });
  expect(log.commits[0]?.subject).toBe(title);
  const status = await runnerApi('aheadBehind', { params: { worktreeId: session.worktreeId! } });
  expect(status.upstream?.ahead).toBe(0);
});

test('W5 · clone principal : le push direct de la branche par défaut est refusé dès la modale', async ({ page, stack, cli }) => {
  test.skip(isMobile(), 'Bureau : modale « Préparer le commit ».');
  const outils = stack.seeded.projects!.outils!;
  const response = await page.request.post('/api/sessions', {
    headers: { origin: stack.urls.web },
    data: { projectId: outils.id, title: `Clone principal ${unique()}`, branch: { mode: 'primary' }, permissionMode: 'acceptEdits' },
  });
  expect(response.status()).toBe(201);
  const { sessionId } = (await response.json()) as { sessionId: string };
  created.push(sessionId);
  const file = `notes-${unique()}.md`;
  const write = await cli.script(`principal-${unique()}`, { description: 'Une note', steps: [{ write: { file, content: 'Note.\n' } }, { final: 'Note ajoutée.' }] });
  await cli.sendInstruction(sessionId, write);
  await cli.waitForTurn(sessionId, write);
  try {
    await openWorkspace(page, sessionId);
    await page.getByRole('button', { name: 'Commit et push' }).click();
    const dialog = page.getByRole('dialog', { name: 'Préparer le commit' });
    await expect(dialog.getByRole('switch', { name: new RegExp(`Pousser sur origin/${outils.defaultBranch}`) })).toBeDisabled();
    await expect(dialog.getByRole('switch', { name: new RegExp(`Pousser sur origin/${outils.defaultBranch}`) })).not.toBeChecked();
    await expect(dialog).toContainText(`${outils.defaultBranch} est la branche par défaut : le push direct est refusé`);
    await expect(dialog.getByRole('button', { name: 'Committer', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Annuler' }).click();
  } finally {
    const cleanup = await cli.script(`principal-nettoyage-${unique()}`, { description: 'Nettoyage', steps: [{ remove: { file }, ask: false }, { final: 'Note retirée.' }] });
    await cli.sendInstruction(sessionId, cleanup);
    await cli.waitForTurn(sessionId, cleanup);
  }
});

test('W6 / S4 · sélecteur des sessions du projet', async ({ page, stack }) => {
  const seeded = stack.seeded.sessions!;
  await openWorkspace(page, seeded.waitingPermission!.id);
  if (isMobile()) {
    await page.getByRole('button', { name: /Changer de session/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Sessions de Devis Express' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Toutes les sessions' })).toHaveAttribute('href', /\/sessions\?projet=/);
    await sheet.getByRole('link', { name: new RegExp(seeded.running!.title) }).click();
  } else {
    await page.getByRole('button', { name: /sessions? sur ce projet : changer de session/ }).click();
    await expect(page.getByText(/DEVIS EXPRESS · \d+ SESSIONS? ACTIVES?/i)).toBeVisible();
    await expect(page.getByText('Chaque session a son worktree : passer de l\'une à l\'autre ne déplace aucun fichier.')).toBeVisible();
    await page.getByRole('link', { name: new RegExp(seeded.running!.title) }).click();
  }
  await expect(page).toHaveURL(new RegExp(`/workspace/${seeded.running!.id}`), { timeout: 60_000 });
});

test('W7 · connexion perdue : bandeau, saisie suspendue, fil figé puis rétabli', async ({ page, stack, context }) => {
  await openWorkspace(page, stack.seeded.sessions!.finished!.id);
  await page.waitForTimeout(1500);
  await context.setOffline(true);
  await expect(page.getByText(/Connexion au serveur perdue/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('textbox', { name: 'Instruction pour Claude' })).toHaveAttribute(
    'placeholder',
    isMobile() ? 'Saisie suspendue…' : 'Saisie suspendue pendant la reconnexion…',
  );
  await expect(page.getByText('Reconnexion…').first()).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Réessayer maintenant' }).click().catch(() => undefined);
  await expect(page.getByText(/Connexion au serveur perdue/)).toHaveCount(0, { timeout: 60_000 });
});

test('W3 · session terminée : résumé de fin, conversation reprenable', async ({ page, stack }) => {
  await openWorkspace(page, stack.seeded.sessions!.finished!.id);
  await expect(page.getByRole('region', { name: /Session terminée · / })).toBeVisible();
  if (!isMobile()) await expect(page.getByText('Conversation enregistrée par Claude Code : reprenable plus tard depuis Sessions.')).toBeVisible();
  await expect(page.getByText(/Terminée · /).first()).toBeVisible();
});

test('Panneau Tests : « Lancer les tests » du worktree, résultats lus en direct', async ({ page, stack }) => {
  test.skip(isMobile(), 'Bureau : onglet Tests du panneau contextuel.');
  await openWorkspace(page, stack.seeded.sessions!.changes!.id, '?panneau=tests');
  const panel = page.getByRole('complementary', { name: 'Panneau contextuel' });
  await panel.getByRole('button', { name: 'Lancer les tests' }).click();
  await expect(panel.getByText('npm run test', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText(/réussis?$/).first()).toBeVisible({ timeout: 90_000 });
  await expect(panel.getByText('Réussis', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(panel.getByText("Résultats lus en direct dans la sortie de la commande, rien n'est simulé.")).toBeVisible();
});

test('Panneau Fichiers : arborescence et aperçu en lecture seule', async ({ page, stack }) => {
  test.skip(isMobile(), 'Bureau : onglet Fichiers du panneau contextuel.');
  await openWorkspace(page, stack.seeded.sessions!.changes!.id, '?panneau=fichiers');
  const panel = page.getByRole('complementary', { name: 'Panneau contextuel' });
  await expect(panel.getByRole('region', { name: 'Aperçu · CLAUDE.md' })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText('Lecture seule')).toBeVisible();
  await panel.getByRole('button', { name: 'src', exact: true }).click();
  await expect(panel.getByRole('button', { name: /devis\.js/ })).toBeVisible({ timeout: 30_000 });
});
