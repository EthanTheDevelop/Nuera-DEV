import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createDb } from '@nuera/db';
import { auditLog } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { E2E_DATABASE_URL, E2E_STACK, expect, hideNextDevIndicator, seedStack, stackRunnerApi, test } from './fixtures';

/**
 * PARCOURS 4 — « Navigateur fermé → session conservée → reprise depuis le téléphone ». One test with
 * TWO browser contexts signed in as the owner: a desktop one (1440×1000), closed while Claude works,
 * then a phone one (390×844, touch, iPhone user agent) that takes over: Accueil M01, Sessions M06,
 * Workspace M05 (events replayed from the runner), permission S1, PhoneComposer, W7, then
 * « Interrompue » (runner restarted) → « Reprendre la session » (claude --resume) → conversation.
 *
 *   E2E_STACK=parcours4 pnpm --filter @nuera/web e2e parcours-4-reprise-telephone.spec.ts --project desktop
 *
 * Runs in the « desktop » Playwright project only: it creates its own phone context. The runner
 * restart interrupts the seeded CLIs too: `seed sessions` puts them back at the end.
 */
test.describe.configure({ mode: 'default' });

const database = createDb(E2E_DATABASE_URL, { max: 1, applicationName: 'e2e-parcours-4' });
const created: string[] = [];
let runnerRestarted = false;

test.afterAll(async () => {
  test.setTimeout(10 * 60_000);
  const api = await stackRunnerApi();
  while (created.length > 0) {
    const sessionId = created.pop()!;
    const session = await api('getSession', { params: { sessionId } }).catch(() => null);
    if (session?.live) await api('stopSession', { params: { sessionId }, body: { force: true } }).catch(() => undefined);
  }
  if (runnerRestarted) await seedStack('sessions');
  await database.$client.end({ timeout: 5 });
});

const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const field = (page: Page) => page.getByRole('textbox', { name: 'Instruction pour Claude' });
const thread = (page: Page) => page.getByRole('log', { name: 'Fil de la session' });
const badge = (page: Page, text: string | RegExp) => page.getByText(text, typeof text === 'string' ? { exact: true } : undefined).first();
const visible = (page: Page, selector: string) => page.locator(`${selector}:visible`);

async function newOwnerContext(browser: Browser, storageState: string, kind: 'desktop' | 'phone'): Promise<BrowserContext> {
  const common = { baseURL: test.info().project.use.baseURL, storageState, locale: 'fr-FR', timezoneId: 'Europe/Paris' };
  return kind === 'desktop'
    ? browser.newContext({ ...common, ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } })
    : browser.newContext({ ...common, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: devices['iPhone 13'].userAgent });
}

/** Restarts the stack's runner (same as `stack.mjs restart runner`): live PTY sessions become « Interrompue ». */
async function restartRunner() {
  const { restart } = await import('./harness/stack');
  await restart(E2E_STACK, 'runner', () => undefined);
}

test('Parcours 4 (bureau puis contexte téléphone) : navigateur fermé, session conservée, reprise depuis le téléphone', async ({ browser, ownerStorageState, stack, runnerApi, cli, waitForSessionStatus }) => {
  test.skip(test.info().project.name !== 'desktop', 'Le test ouvre lui-même son contexte téléphone (projet « desktop » seulement).');
  test.setTimeout(10 * 60_000);
  const u = unique();
  const title = `Reprise téléphone ${u}`;
  const note = `docs/reprise-${u}.md`;
  const session = await cli.createSession({ title, branch: `test/parcours-4-${u}` });
  created.push(session.id);
  const worktree = session.worktree!;

  const sayStart = `Je commence la vérification des totaux (${u}).`;
  const sayAway = `Pendant votre absence, la vérification ${u} a avancé : j'ajoute la note.`;
  const finalFirst = `La note ${note} est ajoutée.`;
  const longInstruction = `${await cli.script(`parcours4-long-${u}`, {
    description: 'Tâche longue : lecture, étape longue, puis écriture soumise à autorisation',
    steps: [
      { say: sayStart },
      { read: 'src/devis.js' },
      { wait: { command: `npm run verifier -- ${u}`, description: 'Vérifie les totaux.', seconds: 12, every: 1, output: [`totaux ${u} vérifiés`] } },
      { say: sayAway },
      { write: { file: note, content: '# Reprise\n\nNote ajoutée pendant que le navigateur était fermé.\n' } },
      { final: finalFirst },
    ],
  })} Vérifie les totaux puis ajoute une note de reprise.`;

  // --- 1. Desktop: the long instruction is sent from the Workspace composer (D05).
  const desktop = await newOwnerContext(browser, ownerStorageState, 'desktop');
  const deskPage = await desktop.newPage();
  await deskPage.goto(`/workspace/${session.id}`);
  await expect(thread(deskPage)).toBeVisible({ timeout: 120_000 });
  await expect(field(deskPage)).not.toHaveAttribute('readonly', '');
  await field(deskPage).fill(longInstruction);
  await field(deskPage).press('Enter');
  await expect(thread(deskPage).getByText(sayStart)).toBeVisible({ timeout: 60_000 });
  await expect(badge(deskPage, /^En cours · /)).toBeVisible({ timeout: 30_000 });

  // --- 2. The desktop browser is closed while Claude works: the session goes on on the runner.
  await desktop.close();
  const running = await runnerApi('getSession', { params: { sessionId: session.id } });
  expect(running).toMatchObject({ status: 'running', live: true });
  const permission = await cli.waitForPermission(session.id, 120_000);
  expect(permission).toMatchObject({ toolName: 'Write', title: 'Claude demande à modifier un fichier' });
  const away = await runnerApi('sessionEvents', { params: { sessionId: session.id }, query: { afterVersion: 0 } });
  expect(away.items.some((item) => item.kind === 'tool' && item.payload.tool === 'Bash' && item.payload.status === 'done')).toBe(true);

  // --- 3. Phone: Accueil M01 shows the session live, waiting for an answer.
  const phone = await newOwnerContext(browser, ownerStorageState, 'phone');
  const page = await phone.newPage();
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible({ timeout: 120_000 });
  await hideNextDevIndicator(page);
  const homeCard = visible(page, `[data-session-card="${session.id}"]`);
  await expect(homeCard).toContainText(title, { timeout: 30_000 });
  await expect(homeCard).toContainText('Autorisation demandée');

  // Sessions M06 lists it; « Répondre » opens M05 on the request.
  await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('link', { name: 'Sessions' }).click();
  await expect(page).toHaveURL(/\/sessions$/, { timeout: 60_000 });
  const card = visible(page, `[data-session-card="${session.id}"]`);
  await expect(card).toContainText('Autorisation demandée', { timeout: 60_000 });
  await card.getByRole('link', { name: 'Répondre' }).click();
  await page.waitForURL(new RegExp(`/workspace/${session.id}#demande-${permission.id}$`), { timeout: 120_000 });
  await hideNextDevIndicator(page);

  // What happened with no browser open is there, once each (replayed from the runner).
  const log = thread(page);
  await expect(log.getByText(sayAway)).toBeVisible({ timeout: 60_000 });
  await expect(log.getByText(sayAway)).toHaveCount(1);
  await expect(log.getByText(sayStart)).toHaveCount(1);
  await expect(log.getByText(longInstruction)).toHaveCount(1);
  await expect(log.getByText(new RegExp(`^Terminé :\\s*Bash\\s*npm run verifier -- ${u}`))).toHaveCount(1);
  await expect(badge(page, 'Autorisation demandée')).toBeVisible();

  // --- 4. Permission answered from the phone (S1 card).
  const request = page.locator(`#demande-${permission.id}`);
  await expect(request.getByRole('heading', { name: 'Claude demande à modifier un fichier' })).toBeVisible({ timeout: 30_000 });
  await expect(request).toContainText(note);
  await request.getByRole('button', { name: 'Autoriser' }).click();
  await expect(log.getByText(finalFirst)).toBeVisible({ timeout: 60_000 });
  await waitForSessionStatus(session.id, 'waiting_input', { timeoutMs: 60_000 });
  await expect.poll(() => existsSync(path.join(worktree.path, note)), { timeout: 30_000 }).toBe(true);
  expect(readFileSync(path.join(worktree.path, note), 'utf8')).toContain('Note ajoutée pendant que le navigateur était fermé.');
  const decision = await database
    .select({ metadata: auditLog.metadata, actor: auditLog.actorUserId })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'permission.decision'), eq(auditLog.targetId, session.id)));
  expect(decision.find((row) => row.metadata?.permissionId === permission.id)).toMatchObject({ actor: stack.owner.userId, metadata: { decision: 'allow', tool: 'Write' } });

  // --- 5. Follow-up instruction from PhoneComposer, result shown.
  const resultFollow = `La note ${note} est relue (${u}).`;
  const follow = `${await cli.script(`parcours4-suite-${u}`, { description: 'Relecture de la note', steps: [{ read: note }, { final: resultFollow }] })} Relis la note.`;
  await field(page).fill(follow);
  await page.getByRole('button', { name: 'Envoyer' }).click();
  await expect(log.getByText(follow)).toBeVisible({ timeout: 60_000 });
  await expect(log.getByText(resultFollow)).toBeVisible({ timeout: 60_000 });
  await cli.waitForTurn(session.id, follow, 60_000);

  // --- 6. W7: the stream drops (phone offline), banner shown; what happens meanwhile is caught up
  // when it comes back, without reloading the page.
  await page.evaluate(() => ((window as unknown as { __parcours4?: boolean }).__parcours4 = true));
  await phone.setOffline(true);
  await expect(page.getByText(/Connexion au serveur perdue/).first()).toBeVisible({ timeout: 60_000 });
  const offline = `Pendant la coupure (${u}), rien n'est perdu.`;
  const offlineInstruction = `${await cli.script(`parcours4-coupure-${u}`, { description: 'Tour pendant la coupure', steps: [{ final: offline }] })} Note la coupure.`;
  await cli.sendInstruction(session.id, offlineInstruction);
  await cli.waitForTurn(session.id, offlineInstruction, 60_000);
  await phone.setOffline(false);
  await expect(page.getByText(/Connexion au serveur perdue/)).toHaveCount(0, { timeout: 60_000 });
  await expect(log.getByText(offline)).toBeVisible({ timeout: 60_000 });
  await expect(log.getByText(offline)).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { __parcours4?: boolean }).__parcours4)).toBe(true);

  // --- 7. Interrupted (runner restarted: the PTY is gone) then resumed from the phone.
  runnerRestarted = true;
  // A second server's live session (account B, « VPS-4 ») must survive the restart of the owner's runner.
  const other = stack.accounts.find((account) => account.key === 'b' && account.created)?.seeded?.sessions?.running;
  const otherBefore = other ? await (await stackRunnerApi('b'))('getSession', { params: { sessionId: other.id } }).catch(() => null) : null;
  await restartRunner();
  await waitForSessionStatus(session.id, 'interrupted', { timeoutMs: 60_000 });
  if (other && otherBefore?.live) {
    const otherAfter = await (await stackRunnerApi('b'))('getSession', { params: { sessionId: other.id } });
    expect(otherAfter).toMatchObject({ live: true, status: otherBefore.status });
  }
  await expect(badge(page, 'Interrompue')).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Actions de session' }).click();
  await page.getByRole('dialog', { name: 'Actions de session' }).getByRole('button', { name: 'Reprendre la session' }).click();
  const resumed = await waitForSessionStatus(session.id, ['waiting_input', 'running'], { timeoutMs: 120_000 });
  expect(resumed.live).toBe(true);
  await expect(badge(page, "En attente d'instruction")).toBeVisible({ timeout: 60_000 });
  expect(page.url()).toContain(`/workspace/${session.id}`);

  const afterResume = `Reprise ${u} : je retrouve la note ${note}.`;
  const resumeInstruction = `${await cli.script(`parcours4-reprise-${u}`, { description: 'Suite après reprise', steps: [{ final: afterResume }] })} Où en étions-nous ?`;
  await expect(field(page)).not.toHaveAttribute('readonly', '');
  await field(page).fill(resumeInstruction);
  await page.getByRole('button', { name: 'Envoyer' }).click();
  await expect(log.getByText(afterResume)).toBeVisible({ timeout: 90_000 });
  await cli.waitForTurn(session.id, resumeInstruction, 60_000);
  // The conversation kept its history across the resume.
  await expect(log.getByText(finalFirst)).toHaveCount(1);
  const resumeAudit = await database
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'session.resume'), eq(auditLog.targetId, session.id)));
  expect(resumeAudit.length).toBeGreaterThanOrEqual(1);

  await phone.close();
});
