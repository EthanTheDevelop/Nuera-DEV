import { rmSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { createDb } from '@nuera/db';
import { auditLog, sessions } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { E2E_DATABASE_URL, expect, hideNextDevIndicator, stackRunnerApi, test } from './fixtures';

/**
 * Sessions toujours reprenables + effort (no Figma frame). Desktop and phone:
 * - a stopped session whose conversation file was deleted (retention, folder lost) offers
 *   « Reprendre avec un nouveau contexte »: the dialog « Reprendre avec le contexte » (checked by
 *   default), then a fresh CLI in the SAME session: the thread keeps its history, the notice and the
 *   summary of the stored history are the first items of the new run, Claude answers it;
 * - the « Effort » chip of the composer types `/effort <level>` into the live CLI and shows the effort
 *   the CLI reports.
 *
 *   node apps/web/e2e/harness/stack.mjs up --name reprise2 --web-port 3680 && … seed --name reprise2 projects
 *   E2E_STACK=reprise2 E2E_WEB_PORT=3680 E2E_SEED=projects pnpm --filter @nuera/web exec playwright test reprise-contexte.spec.ts
 */
test.describe.configure({ mode: 'serial' });

const database = createDb(E2E_DATABASE_URL, { max: 1, applicationName: 'e2e-reprise-contexte' });
const created: string[] = [];

test.afterAll(async () => {
  const api = await stackRunnerApi();
  for (const sessionId of created.splice(0)) {
    const session = await api('getSession', { params: { sessionId } }).catch(() => null);
    if (session?.live) await api('stopSession', { params: { sessionId }, body: { force: true } }).catch(() => undefined);
  }
  await database.$client.end({ timeout: 5 });
});

const isMobile = () => test.info().project.name === 'mobile';
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const field = (page: Page) => page.getByRole('textbox', { name: 'Instruction pour Claude' });
const thread = (page: Page) => page.getByRole('log', { name: 'Fil de la session' });

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
  await expect(thread(page).getByText(text, { exact: true })).toBeVisible({ timeout: 60_000 });
}

test('Conversation perdue : « Reprendre avec le contexte » relance Claude dans la même session', async ({ page, cli, runnerApi, waitForSessionStatus }) => {
  test.setTimeout(5 * 60_000);
  const u = unique();
  const title = `Remise perdue ${u}`;
  const session = await cli.createSession({ title, branch: `test/reprise-contexte-${u}`, permissionMode: 'acceptEdits' });
  created.push(session.id);
  await openWorkspace(page, session.id);
  const first = `Prépare la remise de fidélité ${u}`;
  await sendFromComposer(page, first);
  await expect(thread(page).getByText(`Reçu : ${first}`, { exact: true })).toBeVisible({ timeout: 60_000 });

  // Stopped, then its conversation file disappears (retention of the CLI, folder lost).
  await runnerApi('stopSession', { params: { sessionId: session.id }, body: { force: true } });
  await waitForSessionStatus(session.id, 'stopped', { timeoutMs: 60_000 });
  const [row] = await database.select({ transcriptPath: sessions.transcriptPath }).from(sessions).where(eq(sessions.id, session.id));
  expect(row?.transcriptPath).toBeTruthy();
  rmSync(row!.transcriptPath!, { force: true });
  expect(await runnerApi('getSession', { params: { sessionId: session.id } })).toMatchObject({ resumable: true, resumeMode: 'context' });

  await openWorkspace(page, session.id);
  // Never « Reprise impossible »: the composer stays usable, the menu says what « Reprendre » will do.
  await expect(page.getByText(/Reprise impossible/)).toHaveCount(0);
  if (isMobile()) {
    await page.getByRole('button', { name: 'Actions de session' }).click();
    await page.getByRole('dialog', { name: 'Actions de session' }).getByRole('button', { name: 'Reprendre avec un nouveau contexte' }).click();
  } else {
    await page.getByRole('button', { name: 'Actions de la session' }).click();
    await page.getByRole('menuitem', { name: 'Reprendre avec un nouveau contexte' }).click();
  }
  const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: 'Reprendre avec le contexte' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(`Reprendre « ${title} » avec un nouveau contexte ?`)).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: /Reprendre avec le contexte/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Reprendre la session' }).click();
  await expect(page.getByText('Session reprise avec un nouveau contexte : le résumé de l\'historique est envoyé à Claude.', { exact: true })).toBeVisible({ timeout: 60_000 });

  // Same session, same thread: the first instruction is still there, then the notice and the summary.
  await expect(thread(page).getByText(/^Reprise avec un nouveau contexte : la conversation enregistrée par Claude Code est introuvable/)).toBeVisible({ timeout: 60_000 });
  await expect(thread(page).getByText(new RegExp(`^Reçu : Reprise de la session « ${title} »`))).toBeVisible({ timeout: 90_000 });
  // The owner's first bubble is kept (the summary quotes it again, as a list item of Claude's reply).
  await expect(thread(page).getByRole('paragraph').filter({ hasText: new RegExp(`^${first}$`) }).first()).toBeVisible();
  await expect(thread(page).getByRole('listitem').filter({ hasText: new RegExp(`^${first}$`) }).first()).toBeVisible();
  const live = await waitForSessionStatus(session.id, 'waiting_input', { timeoutMs: 90_000, where: (s) => s.live });
  expect(live).toMatchObject({ resumeMode: 'context', resumeCount: 1 });
  expect(live.lastInstruction).toContain(`Dernières instructions :\n1. ${first}`);
  const [audit] = await database
    .select({ summary: auditLog.summary })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, session.id), eq(auditLog.action, 'session.resume')));
  expect(audit?.summary).toBe(`session reprise avec un nouveau contexte (résumé envoyé) : « ${title} » · Devis Express`);
});

test("Puce « Effort » : /effort tapé dans le CLI, l'effort affiché est celui que le CLI rapporte", async ({ page, cli }) => {
  test.setTimeout(4 * 60_000);
  const u = unique();
  const session = await cli.createSession({ title: `Effort ${u}`, branch: `test/effort-${u}`, permissionMode: 'acceptEdits' });
  created.push(session.id);
  await openWorkspace(page, session.id);
  const say = `Bonjour effort ${u}`;
  await sendFromComposer(page, say);
  await expect(thread(page).getByText(`Reçu : ${say}`, { exact: true })).toBeVisible({ timeout: 60_000 });

  // Phone: the chips live in the « Options de l'instruction » sheet (one button left of the field).
  const openOptions = async () => {
    if (isMobile()) await page.getByRole('button', { name: "Options de l'instruction" }).click();
  };
  const chip = page.getByRole('button', { name: /^Niveau d'effort : / }).filter({ visible: true });
  await openOptions();
  await expect(chip).toHaveAccessibleName("Niveau d'effort : Effort du CLI", { timeout: 30_000 });
  await chip.click();
  if (isMobile()) await page.getByRole('dialog', { name: "Niveau d'effort" }).getByRole('button', { name: /^Élevé/ }).click();
  else await page.getByRole('menuitem', { name: /^Élevé/ }).click();
  await expect(page.getByText('/effort high confirmé par le CLI.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await openOptions();
  await expect(chip).toHaveAccessibleName("Niveau d'effort : Effort élevé", { timeout: 30_000 });
  const [audit] = await database
    .select({ summary: auditLog.summary })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, session.id), eq(auditLog.action, 'session.effort')));
  expect(audit?.summary).toBe(`Effort « high » appliqué · session « Effort ${u} » · Devis Express`);
});
