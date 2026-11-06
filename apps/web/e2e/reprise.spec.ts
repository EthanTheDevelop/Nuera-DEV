import type { Page } from '@playwright/test';
import { createDb } from '@nuera/db';
import { auditLog, spaceSettings } from '@nuera/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { E2E_BASE_URL, E2E_DATABASE_URL, expect, hideNextDevIndicator, stackRunnerApi, test } from './fixtures';

/**
 * « Reprise automatique après la limite d'utilisation » (no Figma frame): the fake CLI stops on its
 * usage limit exactly like the official one (notice « 5-hour limit reached ∙ resets … » printed and
 * written in its transcript, StopFailure `rate_limit`, status line at 100 % with `resets_at`), the
 * runner of the stack resumes 2 s after the reset (NUERA_AUTO_RESUME_MARGIN_SECONDS=2, harness).
 * Desktop and phone: Paramètres › Claude Code, Workspace banner (reset time, scheduled time,
 * countdown, attempts, switch, « Reprendre maintenant »), header, « … » menu / actions sheet,
 * Sessions and Accueil labels, audit log.
 *
 *   node apps/web/e2e/harness/stack.mjs e2e --name reprise -- reprise.spec.ts
 *   (E2E_STACK=reprise E2E_WEB_PORT=3640 E2E_SEED=projects for a fresh stack)
 */
test.describe.configure({ mode: 'serial' });

const database = createDb(E2E_DATABASE_URL, { max: 1, applicationName: 'e2e-reprise' });
const created: string[] = [];

test.afterAll(async () => {
  const api = await stackRunnerApi();
  for (const sessionId of created.splice(0)) {
    const session = await api('getSession', { params: { sessionId } }).catch(() => null);
    if (session?.live) await api('stopSession', { params: { sessionId }, body: { force: true } }).catch(() => undefined);
  }
  await database.update(spaceSettings).set({ autoResumeAfterLimit: false, autoResumeInstruction: null });
  await database.$client.end({ timeout: 5 });
});

const isMobile = () => test.info().project.name === 'mobile';
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const field = (page: Page) => page.getByRole('textbox', { name: 'Instruction pour Claude' });
const thread = (page: Page) => page.getByRole('log', { name: 'Fil de la session' });
const banner = (page: Page) => page.getByRole('alert').filter({ hasText: "Limite d'utilisation atteinte" }).filter({ has: page.getByRole('switch') });

async function patchSettings(page: Page, patch: Record<string, unknown>) {
  const response = await page.request.patch('/api/settings', { data: patch, headers: { origin: E2E_BASE_URL } });
  expect(response.status(), await response.text()).toBe(200);
}

async function openWorkspace(page: Page, sessionId: string) {
  await page.goto(`/workspace/${sessionId}`);
  await expect(thread(page)).toBeVisible({ timeout: 120_000 });
  await hideNextDevIndicator(page);
}

async function sendFromComposer(page: Page, text: string) {
  const input = field(page);
  await expect(input).not.toHaveAttribute('readonly', '');
  await input.fill(text);
  if (isMobile()) await page.getByRole('button', { name: 'Envoyer' }).click();
  else await input.press('Enter');
  await expect(thread(page).getByText(text)).toBeVisible({ timeout: 60_000 });
}

async function audits(sessionId: string, actions: string[]) {
  return database
    .select({ action: auditLog.action, summary: auditLog.summary })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, sessionId), inArray(auditLog.action, actions)))
    .orderBy(auditLog.id);
}

test("Paramètres › Claude Code : reprise automatique par défaut et instruction de reprise", async ({ page }) => {
  test.skip(isMobile(), "Réglage de l'espace vérifié sur bureau ; le téléphone ouvre le même onglet.");
  await patchSettings(page, { autoResumeAfterLimit: false, autoResumeInstruction: null });
  await page.goto('/parametres?onglet=claude-code');
  const toggle = page.getByRole('switch', { name: "Reprise automatique après la limite d'utilisation" });
  await expect(toggle).toBeVisible({ timeout: 120_000 });
  await expect(toggle).not.toBeChecked();
  const instruction = page.getByRole('textbox', { name: 'Instruction de reprise' });
  await expect(instruction).toHaveAttribute('placeholder', "Continue là où tu t'es arrêté.");
  await toggle.click();
  await expect(page.getByText('Reprise automatique activée par défaut', { exact: true }).first()).toBeVisible();
  await expect(toggle).toBeChecked();
  await instruction.fill('Reprends la livraison du devis.');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Instruction de reprise enregistrée', { exact: true }).first()).toBeVisible();
  const [row] = await database.select({ on: spaceSettings.autoResumeAfterLimit, text: spaceSettings.autoResumeInstruction }).from(spaceSettings);
  expect(row).toEqual({ on: true, text: 'Reprends la livraison du devis.' });
  await page.reload();
  await expect(page.getByRole('switch', { name: "Reprise automatique après la limite d'utilisation" })).toBeChecked({ timeout: 60_000 });
  await patchSettings(page, { autoResumeAfterLimit: false, autoResumeInstruction: null });
});

test('Limite atteinte : bandeau avec heure de levée et compte à rebours, puis reprise automatique', async ({ page, cli, runnerApi, waitForSessionStatus }) => {
  test.setTimeout(5 * 60_000);
  await patchSettings(page, { autoResumeAfterLimit: true, autoResumeInstruction: null });
  const u = unique();
  const session = await cli.createSession({ title: `Livraison limitée ${u}`, branch: `test/reprise-auto-${u}`, permissionMode: 'acceptEdits' });
  created.push(session.id);
  await openWorkspace(page, session.id);
  // First instruction from the composer: the web starts the CLI with the space's « reprise automatique ».
  await sendFromComposer(page, 'scenario:limite-levee Continue la livraison.');

  const notice = banner(page);
  await expect(notice).toBeVisible({ timeout: 60_000 });
  await expect(thread(page).getByText("Limite d'utilisation atteinte.", { exact: true })).toBeVisible();
  // The CLI's own notice: as Claude's message (transcript) and as the detail of the error line (hook).
  await expect(thread(page).getByText(/^5-hour limit reached ∙ resets /)).toHaveCount(2);
  await expect(notice.getByTestId('limite-detail')).toHaveText(/^Le CLI annonce la levée de la limite à \d{1,2} h \d{2}\. Reprise automatique à \d{1,2} h \d{2} \(tentative 1 sur 5\)\.$/);
  await expect(notice.getByTestId('limite-compte-a-rebours')).toHaveText(/ · dans \d+ s$/);
  await expect(notice.getByRole('switch', { name: 'Reprise automatique' })).toBeChecked();
  await expect(page.getByTestId('limite-entete').filter({ visible: true })).toHaveText(/^Limite atteinte · reprise à \d{1,2} h \d{2}$/);
  const limited = await runnerApi('getSession', { params: { sessionId: session.id } });
  expect(limited.limit).toMatchObject({ active: true, window: 'five_hour', autoResume: { enabled: true, outcome: 'scheduled', mode: 'reset' } });
  expect(Date.parse(limited.limit!.autoResume!.nextAttemptAt!) - Date.parse(limited.limit!.resetsAt!)).toBe(2000);

  // Reset + 2 s: the default instruction is typed into the same live CLI, the banner goes away.
  await expect(thread(page).getByText("Reprise automatique après la limite d'utilisation (tentative 1 sur 5)")).toBeVisible({ timeout: 90_000 });
  await expect(thread(page).getByText("Continue là où tu t'es arrêté.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(notice).toBeHidden({ timeout: 60_000 });
  await expect(page.getByTestId('limite-entete')).toHaveCount(0);
  const resumed = await waitForSessionStatus(session.id, 'waiting_input', { timeoutMs: 60_000, where: (s) => s.limit === null && s.lastInstruction === "Continue là où tu t'es arrêté." });
  expect(resumed.errorCode).toBeNull();
  await expect
    .poll(async () => (await audits(session.id, ['session.auto_resume_scheduled', 'session.auto_resume_fired'])).map((a) => a.action), { timeout: 30_000 })
    .toEqual(['session.auto_resume_scheduled', 'session.auto_resume_fired']);
  await patchSettings(page, { autoResumeAfterLimit: false });
});

test("Choix propre à la session, « Reprendre maintenant », libellés de Sessions et de l'Accueil", async ({ page, cli, runnerApi }) => {
  test.setTimeout(5 * 60_000);
  await patchSettings(page, { autoResumeAfterLimit: false, autoResumeInstruction: null });
  const u = unique();
  const session = await cli.createSession({ title: `Limite longue ${u}`, branch: `test/reprise-main-${u}`, permissionMode: 'acceptEdits' });
  created.push(session.id);
  await openWorkspace(page, session.id);
  await sendFromComposer(page, 'scenario:limit:900 Écris les tests du devis.');

  const notice = banner(page);
  await expect(notice).toBeVisible({ timeout: 60_000 });
  // Space default off: only the reset the CLI gave.
  await expect(notice.getByTestId('limite-detail')).toHaveText(/^Le CLI annonce la levée de la limite à \d{1,2} h \d{2}\. Reprenez la session quand vous le souhaitez\.$/);
  await expect(page.getByTestId('limite-entete').filter({ visible: true })).toHaveText(/^Limite atteinte · levée à \d{1,2} h \d{2}$/);
  const toggle = notice.getByRole('switch', { name: 'Reprise automatique' });
  await expect(toggle).not.toBeChecked();

  // On for this session only (banner switch): scheduled at the reset + 2 s.
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(notice.getByTestId('limite-detail')).toHaveText(/Reprise automatique à \d{1,2} h \d{2} \(tentative 1 sur 5\)\.$/, { timeout: 30_000 });
  await expect(page.getByTestId('limite-entete').filter({ visible: true })).toHaveText(/^Limite atteinte · reprise à /);
  expect((await runnerApi('getSession', { params: { sessionId: session.id } })).limit?.autoResume).toMatchObject({ enabled: true, outcome: 'scheduled' });

  // Off again from the « … » menu (desktop) / the actions sheet (phone).
  if (isMobile()) {
    await page.getByRole('button', { name: 'Actions de session' }).click();
    const sheetSwitch = page.getByRole('dialog', { name: 'Actions de session' }).getByRole('switch', { name: 'Reprise automatique après la limite' });
    await expect(sheetSwitch).toBeChecked();
    await sheetSwitch.click();
    await expect(sheetSwitch).not.toBeChecked();
    await page.keyboard.press('Escape');
  } else {
    await page.getByRole('button', { name: 'Actions de la session' }).click();
    const item = page.getByRole('menuitemcheckbox', { name: /Reprise automatique après la limite/ });
    await expect(item).toHaveAttribute('aria-checked', 'true');
    await item.click();
  }
  await expect(toggle).not.toBeChecked({ timeout: 30_000 });
  await expect(notice.getByTestId('limite-detail')).toHaveText(/Reprenez la session quand vous le souhaitez\.$/, { timeout: 30_000 });
  expect((await runnerApi('getSession', { params: { sessionId: session.id } })).limit?.autoResume).toMatchObject({ enabled: false, outcome: 'off' });

  // Sessions and Accueil say why the session waits.
  await page.goto('/sessions');
  await expect(page.locator(`[data-session-card="${session.id}"]`).filter({ visible: true }).getByText(/^Limite atteinte · levée à \d{1,2} h \d{2}$/)).toBeVisible({ timeout: 120_000 });
  await page.goto('/');
  await expect(page.getByText(/^Limite atteinte · levée à \d{1,2} h \d{2}$/).filter({ visible: true }).first()).toBeVisible({ timeout: 120_000 });

  // « Reprendre maintenant »: the instruction of reprise is typed now; the limit is still there, the CLI says so again.
  await openWorkspace(page, session.id);
  await banner(page).getByRole('button', { name: 'Reprendre maintenant' }).click();
  await expect(thread(page).getByText("Continue là où tu t'es arrêté.", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(thread(page).getByText("Limite d'utilisation atteinte.", { exact: true })).toHaveCount(2, { timeout: 60_000 });
  await expect(banner(page)).toBeVisible({ timeout: 60_000 });
  expect((await audits(session.id, ['session.auto_resume_changed', 'session.auto_resume_now'])).map((a) => a.action)).toEqual([
    'session.auto_resume_changed',
    'session.auto_resume_changed',
    'session.auto_resume_now',
  ]);
  await runnerApi('stopSession', { params: { sessionId: session.id }, body: { force: true } });
});
