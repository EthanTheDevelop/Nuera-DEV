import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { generate } from 'otplib';
import type { StackKey } from '../harness/config';
import { E2E_OWNER, E2E_SETUP_TOKEN, OWNER_STATE_FILE, accountStateFile } from './env';

/**
 * Account helpers for e2e tests (any lot) and for the stack launcher (apps/web/e2e/harness):
 *
 *   await createOwnerAndSignIn(page);   // first call runs /configuration, later calls sign in
 *   await signIn(page, readOwnerState()!, { method: 'backup' });
 *   await signInAs(page, 'b');          // the invited member of the stack (E2E_ACCOUNTS ≥ 2)
 *   await signOut(page);
 *
 * Each account's state (credentials, TOTP secret, unused backup codes) lives in
 * `.data/stacks/<E2E_STACK>/owner.json` (account `a`, the owner) or `accounts/<key>.json` — test data
 * only, reset with the stack (`up --reset`). Every function takes an optional state file so that the
 * launcher can drive any stack.
 */

export interface OwnerState {
  name: string;
  email: string;
  password: string;
  /** Base32 TOTP key, as displayed for manual entry. */
  totpSecret: string;
  /** Backup codes not used yet. */
  backupCodes: string[];
}

/** State of any account of the stack (same shape as the owner's). */
export type AccountState = OwnerState;

export interface OwnerIdentityInput {
  name: string;
  email: string;
  password: string;
}

export function readOwnerState(file = OWNER_STATE_FILE): OwnerState | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as OwnerState;
}

export function writeOwnerState(state: OwnerState, file = OWNER_STATE_FILE): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

/** State of account `key` of the selected stack (null when it was never created). */
export function readAccountState(key: StackKey, file = accountStateFile(key)): AccountState | null {
  return readOwnerState(file);
}

/** Current TOTP code for a base32 key (what the authenticator app would show). */
export async function totpCode(secret: string): Promise<string> {
  return generate({ secret: secret.replace(/\s+/g, '') });
}

/** True while /configuration still offers the owner creation (fresh database). */
export async function setupAvailable(page: Page): Promise<boolean> {
  const response = await page.goto('/configuration');
  if (response?.status() === 404) return false;
  // Waits for the card title (a dev-server reload can briefly replace the page).
  const title = page.locator('#auth-card-title');
  await title.waitFor({ state: 'visible', timeout: 60_000 });
  return (await title.innerText()).trim() === 'Créer le compte propriétaire';
}

export interface OwnerSetupOptions {
  /** SETUP_TOKEN of the server (default: the test token every stack uses). */
  setupToken?: string;
  /** Where to write the owner state (default: the selected stack's owner.json). */
  stateFile?: string;
}

/**
 * Second-factor enrolment shared by the owner setup (/configuration) and the account activation of an
 * invitation (/invitation/<jeton>): TOTP (manual key read from the page) → 8 backup codes → passkey
 * « Plus tard » → Accueil. Returns the TOTP secret and the backup codes; `onCodes` is called before
 * leaving the codes step (the state must be saved before the account can be used).
 */
export async function completeEnrolment(page: Page, onCodes: (secret: string, codes: string[]) => void): Promise<{ totpSecret: string; backupCodes: string[] }> {
  const manualKey = page.getByTestId('totp-manual-key');
  await manualKey.waitFor({ state: 'visible', timeout: 120_000 });
  const totpSecret = (await manualKey.innerText()).replace(/\s+/g, '');
  expect(totpSecret).toMatch(/^[A-Z2-7]{32,}$/);
  await page.getByLabel('Code à 6 chiffres').fill(await totpCode(totpSecret));
  await page.getByRole('button', { name: 'Activer la double authentification' }).click();

  const codesList = page.getByTestId('backup-codes');
  await codesList.waitFor({ state: 'visible', timeout: 120_000 });
  const backupCodes = (await codesList.locator('li').allInnerTexts()).map((code) => code.trim());
  expect(backupCodes).toHaveLength(8);
  onCodes(totpSecret, backupCodes);
  await page.getByRole('button', { name: "J'ai conservé mes codes" }).click();

  await page.getByRole('button', { name: /^(Plus tard|Terminer)$/ }).click();
  await page.waitForURL((url) => url.pathname === '/', { timeout: 120_000 });
  return { totpSecret, backupCodes };
}

/** Full owner setup through the UI: token → account → TOTP → backup codes → (no passkey) → Accueil. */
export async function completeOwnerSetup(page: Page, owner: OwnerIdentityInput = E2E_OWNER, options: OwnerSetupOptions = {}): Promise<OwnerState> {
  await page.goto('/configuration');
  await page.getByLabel('Jeton de configuration').fill(options.setupToken ?? E2E_SETUP_TOKEN);
  await page.getByLabel('Nom', { exact: true }).fill(owner.name);
  await page.getByLabel('E-mail').fill(owner.email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(owner.password);
  await page.getByLabel('Confirmer le mot de passe').fill(owner.password);
  await page.getByRole('button', { name: 'Créer le compte' }).click();

  await page.waitForURL('**/configuration/double-facteur');
  let state: OwnerState | null = null;
  await completeEnrolment(page, (totpSecret, backupCodes) => {
    state = { name: owner.name, email: owner.email, password: owner.password, totpSecret, backupCodes };
    writeOwnerState(state, options.stateFile);
  });
  return state!;
}

export interface InvitationOptions {
  /** Where to write the account state (default: accounts/<key>.json of the selected stack). */
  stateFile: string;
}

/**
 * Accepts an invitation through the real pages: /invitation/<jeton> (name, password — the e-mail is
 * the invited one), then « Activation de votre compte » (mandatory TOTP, backup codes, passkey later).
 */
export async function acceptInvitation(page: Page, inviteUrl: string, identity: OwnerIdentityInput, options: InvitationOptions): Promise<AccountState> {
  await page.goto(inviteUrl);
  const email = page.getByLabel('E-mail');
  if (await email.isVisible().catch(() => false)) {
    // Pre-filled with the invited address (read-only): it is checked, never typed.
    await expect(email).toHaveValue(identity.email);
  }
  const nameField = page.getByLabel('Nom', { exact: true });
  if (await nameField.isVisible().catch(() => false)) await nameField.fill(identity.name);
  await page.getByLabel('Mot de passe', { exact: true }).fill(identity.password);
  await page.getByLabel('Confirmer le mot de passe').fill(identity.password);
  await page.getByRole('button', { name: /^Créer (mon|le) compte$/ }).click();
  let state: AccountState | null = null;
  await completeEnrolment(page, (totpSecret, backupCodes) => {
    state = { name: identity.name, email: identity.email, password: identity.password, totpSecret, backupCodes };
    writeOwnerState(state, options.stateFile);
  });
  return state!;
}

export interface SignInOptions {
  method?: 'totp' | 'backup';
  /** Path to come back to after sign-in (`?suivant=`). */
  next?: string;
  /** Account state file updated when a backup code is consumed (default: the selected stack's owner). */
  stateFile?: string;
}

/** Password + second factor through /connexion. Consumes a backup code with method 'backup'. */
export async function signIn(page: Page, owner: OwnerState, options: SignInOptions = {}): Promise<void> {
  const next = options.next ?? '/';
  await page.goto(next === '/' ? '/connexion' : `/connexion?suivant=${encodeURIComponent(next)}`);
  await page.getByLabel('E-mail').fill(owner.email);
  await page.getByLabel('Mot de passe').fill(owner.password);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await page.waitForURL('**/connexion/deux-facteurs**');

  if (options.method === 'backup') {
    const [code, ...rest] = owner.backupCodes;
    if (!code) throw new Error(`Plus aucun code de secours disponible pour ${owner.email}.`);
    await page.getByRole('button', { name: 'Utiliser un code de secours' }).click();
    await page.getByLabel('Code de secours').fill(code);
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/connexion'));
    owner.backupCodes = rest;
    writeOwnerState(owner, options.stateFile);
    return;
  }

  await page.getByLabel('Code à 6 chiffres').fill(await totpCode(owner.totpSecret));
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/connexion'));
}

/** Signs `page` in as account `key` of the selected stack (password + TOTP). */
export async function signInAs(page: Page, key: StackKey, options: Omit<SignInOptions, 'stateFile'> = {}): Promise<AccountState> {
  const file = accountStateFile(key);
  const account = readOwnerState(file);
  if (!account) throw new Error(`Compte « ${key} » absent de la pile (${file}) : lancez la suite avec E2E_ACCOUNTS ≥ 2 ou \`stack.mjs up --accounts 2\`.`);
  await signIn(page, account, { ...options, stateFile: file });
  return account;
}

/** Signs the current page's context out (POST form of /deconnexion). */
export async function signOut(page: Page): Promise<void> {
  await page.goto('/deconnexion');
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await page.waitForURL('**/connexion**');
}

/**
 * Ensures the owner exists and the page is signed in (TOTP). Creates the owner through
 * /configuration on a fresh stack (`up --pristine`), otherwise signs in with the stored credentials.
 */
export async function createOwnerAndSignIn(page: Page, options: { stateFile?: string } = {}): Promise<OwnerState> {
  const stored = readOwnerState(options.stateFile);
  if (stored) {
    await signIn(page, stored, { stateFile: options.stateFile });
    return stored;
  }
  if (!(await setupAvailable(page))) {
    throw new Error(
      'Le propriétaire existe déjà mais son état local (.data/stacks/<pile>/owner.json) est introuvable : recréez la pile (`stack.mjs up --reset`).',
    );
  }
  return completeOwnerSetup(page, E2E_OWNER, { stateFile: options.stateFile });
}

/**
 * Regenerates the 8 backup codes when fewer than `min` remain (Better Auth endpoint, from a
 * signed-in request context). Keeps the backup-code e2e journeys usable on a long-lived stack.
 */
export async function ensureBackupCodes(request: APIRequestContext, baseUrl: string, options: { stateFile?: string; min?: number } = {}): Promise<number> {
  const owner = readOwnerState(options.stateFile);
  if (!owner) throw new Error('État du compte introuvable.');
  if (owner.backupCodes.length >= (options.min ?? 3)) return owner.backupCodes.length;
  const response = await request.post(`${baseUrl}/api/auth/two-factor/generate-backup-codes`, {
    data: { password: owner.password },
    headers: { origin: baseUrl, 'content-type': 'application/json' },
  });
  if (!response.ok()) throw new Error(`Régénération des codes de secours refusée (HTTP ${response.status()}).`);
  const body = (await response.json()) as { backupCodes?: string[] };
  if (!body.backupCodes?.length) throw new Error('Régénération des codes de secours : réponse inattendue.');
  owner.backupCodes = body.backupCodes;
  writeOwnerState(owner, options.stateFile);
  return owner.backupCodes.length;
}
