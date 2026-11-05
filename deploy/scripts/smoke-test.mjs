#!/usr/bin/env node
/**
 * Smoke test of a freshly started compose (LOCAL trial only, deploy/docker-compose.test.yml) — never run it against
 * production: it creates the owner account with SETUP_TOKEN.
 *
 *   node deploy/scripts/smoke-test.mjs --env deploy/.env.test [--out /tmp/smoke]
 *
 * Steps: /api/health → /configuration (token, account, TOTP, backup codes) → sign-out → sign-in (password + TOTP)
 * → shell (Accueil) → Paramètres shows the CLI state → a `claude-status` terminal opens through the runner and closes.
 * Uses Playwright and otplib from apps/web (test dependencies), and the Chromium preinstalled for the e2e tests.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireFromWeb = createRequire(path.join(repoRoot, 'apps/web/package.json'));
const { chromium } = requireFromWeb('@playwright/test');
const { generate } = requireFromWeb('otplib');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const envFile = path.resolve(arg('env', path.join(repoRoot, 'deploy/.env.test')));
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const base = env.APP_URL;
const out = arg('out', '');
if (out) mkdirSync(out, { recursive: true });

const owner = { name: 'Propriétaire Essai', email: 'essai@nuera.test', password: 'Kiwi-orbite-7342-Lune!' };
const step = (label) => console.info(`✓ ${label}`);
const fail = (label) => {
  throw new Error(label);
};
const shot = async (page, name) => {
  if (out) await page.screenshot({ path: path.join(out, `${name}.png`) });
};
/** Waits for the next 30 s TOTP period so a code is never reused (replay protection). */
const freshTotp = async (secret) => {
  const left = 30 - (Math.floor(Date.now() / 1000) % 30);
  await new Promise((r) => setTimeout(r, (left + 1) * 1000));
  return generate({ secret });
};

const health = await fetch(`${base}/api/health`);
const healthBody = await health.text();
if (health.status !== 200) fail(`/api/health → ${health.status} ${healthBody}`);
step(`/api/health → 200 ${healthBody}`);

const executablePath = arg('chromium', process.env.E2E_CHROMIUM_PATH || undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 }, locale: 'fr-FR' });
  context.setDefaultTimeout(60_000);
  const page = await context.newPage();

  await page.goto('/configuration');
  await page.getByLabel('Jeton de configuration').fill(env.SETUP_TOKEN);
  await page.getByLabel('Nom', { exact: true }).fill(owner.name);
  await page.getByLabel('E-mail').fill(owner.email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(owner.password);
  await page.getByLabel('Confirmer le mot de passe').fill(owner.password);
  await page.getByRole('button', { name: 'Créer le compte' }).click();
  await page.waitForURL('**/configuration/double-facteur');
  const secret = (await page.getByTestId('totp-manual-key').innerText()).replace(/\s+/g, '');
  await page.getByLabel('Code à 6 chiffres').fill(await generate({ secret }));
  await page.getByRole('button', { name: 'Activer la double authentification' }).click();
  await page.waitForURL('**/configuration/codes-de-secours');
  const codes = await page.getByTestId('backup-codes').locator('li').count();
  if (codes !== 8) fail(`codes de secours : ${codes} au lieu de 8`);
  await page.getByRole('button', { name: "J'ai conservé mes codes" }).click();
  await page.waitForURL('**/configuration/cle-d-acces');
  await page.getByRole('button', { name: /^(Plus tard|Terminer)$/ }).click();
  await page.waitForURL((url) => url.pathname === '/');
  step('/configuration : compte propriétaire créé (SETUP_TOKEN, TOTP, 8 codes de secours)');

  const again = await page.goto('/configuration');
  step(`/configuration après création → ${again?.status()} (${new URL(page.url()).pathname})`);

  await page.goto('/deconnexion');
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await page.waitForURL('**/connexion**');
  await page.getByLabel('E-mail').fill(owner.email);
  await page.getByLabel('Mot de passe').fill(owner.password);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await page.waitForURL('**/connexion/deux-facteurs**');
  await page.getByLabel('Code à 6 chiffres').fill(await freshTotp(secret));
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/connexion'));
  step('connexion : mot de passe + TOTP');

  await page.goto('/');
  await page.getByRole('link', { name: 'Paramètres', exact: true }).first().waitFor();
  await page.getByText('Claude Code déconnecté').first().waitFor();
  await shot(page, 'accueil');
  step('shell chargé (Accueil) · barre latérale « Claude Code déconnecté »');

  await page.goto('/parametres');
  const badge = page.getByText(/^(Déconnecté|CLI absent|Connecté.*|Mauvaise méthode|État illisible)$/).first();
  await badge.waitFor();
  const cliState = (await badge.innerText()).trim();
  await shot(page, 'parametres');
  if (cliState.startsWith('Connecté')) fail('le CLI ne devrait pas être connecté sur une installation neuve');
  step(`Paramètres : Claude Code « ${cliState} »`);

  const created = await page.request.post('/api/terminals', { data: { kind: 'claude-status', cols: 100, rows: 30 }, headers: { origin: base } });
  const createdBody = await created.json().catch(() => ({}));
  if (!created.ok()) fail(`POST /api/terminals → ${created.status()} ${JSON.stringify(createdBody)}`);
  const terminal = createdBody.terminal;
  step(`terminal claude-status ouvert par le runner (${terminal.id}, ${terminal.status ?? terminal.state ?? 'ouvert'})`);
  await new Promise((r) => setTimeout(r, 3000));
  const info = await page.request.get(`/api/terminals/${terminal.id}`);
  step(`GET /api/terminals/:id → ${info.status()} ${JSON.stringify((await info.json().catch(() => ({}))).terminal ?? {}).slice(0, 200)}`);
  const closed = await page.request.delete(`/api/terminals/${terminal.id}`, { headers: { origin: base } });
  step(`DELETE /api/terminals/:id → ${closed.status()}`);
  await context.close();
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    await shot(page, 'echec');
    console.error(`Échec sur ${page.url()} :\n${(await page.locator('body').innerText().catch(() => '')).slice(0, 1500)}`);
  }
  throw error;
} finally {
  await browser.close();
}
console.info('Essai de fumée terminé.');
