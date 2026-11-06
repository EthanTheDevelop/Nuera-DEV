import type { Page } from '@playwright/test';
import { expect, hideNextDevIndicator, test } from './fixtures';

/**
 * Dictation in the Workspace composer (desktop Composer, PhoneComposer): the browser's speech
 * recognition is replaced by a TEST-ONLY fake injected before the page scripts (no microphone,
 * no network), or removed to check the unsupported state.
 *
 *   node apps/web/e2e/harness/stack.mjs e2e --name dictee -- dictee.spec.ts
 *   (E2E_STACK=dictee E2E_WEB_PORT=3630 E2E_SEED=projects for a fresh stack)
 */
test.describe.configure({ mode: 'default' });

const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const created: string[] = [];

test.afterAll(async () => {
  const { stackRunnerApi } = await import('./fixtures');
  const api = await stackRunnerApi();
  for (const sessionId of created.splice(0)) {
    const session = await api('getSession', { params: { sessionId } }).catch(() => null);
    if (session?.live) await api('stopSession', { params: { sessionId }, body: { force: true } }).catch(() => undefined);
  }
});

/** TEST-ONLY: a SpeechRecognition the test drives with `window.__hear(text, isFinal)`. */
function installFakeRecognition(page: Page) {
  return page.addInitScript(() => {
    type Result = { transcript: string; isFinal: boolean };
    const w = window as unknown as Record<string, unknown>;
    class FakeRecognition {
      lang = '';
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      results: Result[] = [];
      start() {
        w.__dictation = this;
        w.__dictationLang = this.lang;
      }
      stop() {
        setTimeout(() => this.onend?.(), 10);
      }
      abort() {
        this.onend = null;
      }
    }
    w.SpeechRecognition = FakeRecognition;
    w.webkitSpeechRecognition = FakeRecognition;
    w.__hear = (transcript: string, isFinal: boolean) => {
      const rec = w.__dictation as FakeRecognition | undefined;
      if (!rec) throw new Error('aucune dictée en cours');
      const last = rec.results.at(-1);
      const index = last && !last.isFinal ? rec.results.length - 1 : rec.results.length;
      rec.results[index] = { transcript, isFinal };
      rec.onresult?.({
        resultIndex: index,
        results: rec.results.map((r) => Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal })),
      });
    };
  });
}

async function openNewSession(page: Page, cli: { createSession: (input: { title: string; branch: string }) => Promise<{ id: string }> }) {
  const session = await cli.createSession({ title: `Dictée ${unique()}`, branch: `test/dictee-${unique()}` });
  created.push(session.id);
  await page.goto(`/workspace/${session.id}`);
  const field = page.getByRole('textbox', { name: 'Instruction pour Claude' });
  await expect(field).toBeVisible({ timeout: 120_000 });
  await hideNextDevIndicator(page);
  return { session, field };
}

test('Dictée indisponible : bouton inactif, raison affichée', async ({ page, cli }) => {
  await page.addInitScript(() => {
    for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
      Object.defineProperty(window, name, { value: undefined, configurable: true, writable: true });
    }
  });
  await openNewSession(page, cli);
  const mic = page.getByRole('button', { name: "Dicter l'instruction" });
  await expect(mic).toHaveAttribute('data-dictation', 'unsupported');
  await expect(mic).toHaveAttribute('aria-disabled', 'true');
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  // aria-disabled (not disabled): still tappable, the reason is written under the field (no tooltip on a phone).
  await mic.click({ force: true });
  await expect(
    page.getByText("La dictée n'est pas disponible dans ce navigateur : utilisez la dictée du clavier de votre téléphone ou Chrome / Safari."),
  ).toBeVisible();
  await expect(page.getByText("À l'écoute…")).toHaveCount(0);
});

test('Dictée : texte provisoire affiché, texte final inséré, rien envoyé', async ({ page, cli, runnerApi }) => {
  await installFakeRecognition(page);
  const { session, field } = await openNewSession(page, cli);
  await field.fill('Regarde');

  const mic = page.getByRole('button', { name: "Dicter l'instruction" });
  await expect(mic).toHaveAttribute('data-dictation', 'supported');
  await mic.click();
  const stop = page.getByRole('button', { name: 'Arrêter la dictée' });
  await expect(stop).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText("À l'écoute…")).toBeVisible();
  await expect(page.getByText("La reconnaissance vocale est assurée par votre navigateur (Apple ou Google) : l'audio ne passe pas par Nuera Dev.")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __dictationLang: string }).__dictationLang)).toBe('fr-FR');

  await page.evaluate(() => (window as unknown as { __hear: (t: string, f: boolean) => void }).__hear('le fichier', false));
  await expect(page.locator('[data-dictation-interim]')).toHaveText('le fichier');
  await expect(field).toHaveValue('Regarde');
  await test.info().attach('dictée en cours', { body: await page.screenshot(), contentType: 'image/png' });

  await page.evaluate(() => (window as unknown as { __hear: (t: string, f: boolean) => void }).__hear('le fichier README', true));
  await expect(field).toHaveValue('Regarde le fichier README');
  await expect(page.locator('[data-dictation-interim]')).toHaveCount(0);

  await stop.click();
  await expect(page.getByRole('button', { name: "Dicter l'instruction" })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText("À l'écoute…")).toHaveCount(0);
  await expect(field).toHaveValue('Regarde le fichier README');
  // Never sent by itself: the session has not started.
  expect((await runnerApi('getSession', { params: { sessionId: session.id } })).status).toBe('new');
});
