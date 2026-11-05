import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { generate } from 'otplib';
import { E2E_OWNER, E2E_SETUP_TOKEN, E2E_STATE_DIR, OWNER_STATE_FILE } from './env';

/**
 * Owner helpers for e2e tests (any lot):
 *
 *   await createOwnerAndSignIn(page);   // first call runs /configuration, later calls sign in
 *   await signIn(page, readOwnerState()!, { method: 'backup' });
 *   await signOut(page);
 *
 * The owner state (credentials, TOTP secret, unused backup codes) lives in
 * apps/web/.playwright/<database>/owner.json — test data only, reset with the database.
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

export function readOwnerState(): OwnerState | null {
  if (!existsSync(OWNER_STATE_FILE)) return null;
  return JSON.parse(readFileSync(OWNER_STATE_FILE, 'utf8')) as OwnerState;
}

export function writeOwnerState(state: OwnerState): void {
  mkdirSync(E2E_STATE_DIR, { recursive: true });
  writeFileSync(OWNER_STATE_FILE, JSON.stringify(state, null, 2));
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

/** Full owner setup through the UI: token → account → TOTP → backup codes → (no passkey) → Accueil. */
export async function completeOwnerSetup(page: Page, owner = E2E_OWNER): Promise<OwnerState> {
  await page.goto('/configuration');
  await page.getByLabel('Jeton de configuration').fill(E2E_SETUP_TOKEN);
  await page.getByLabel('Nom', { exact: true }).fill(owner.name);
  await page.getByLabel('E-mail').fill(owner.email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(owner.password);
  await page.getByLabel('Confirmer le mot de passe').fill(owner.password);
  await page.getByRole('button', { name: 'Créer le compte' }).click();

  await page.waitForURL('**/configuration/double-facteur');
  const totpSecret = (await page.getByTestId('totp-manual-key').innerText()).replace(/\s+/g, '');
  expect(totpSecret).toMatch(/^[A-Z2-7]{32,}$/);
  await page.getByLabel('Code à 6 chiffres').fill(await totpCode(totpSecret));
  await page.getByRole('button', { name: 'Activer la double authentification' }).click();

  await page.waitForURL('**/configuration/codes-de-secours');
  const backupCodes = (await page.getByTestId('backup-codes').locator('li').allInnerTexts()).map((code) => code.trim());
  expect(backupCodes).toHaveLength(8);
  const state: OwnerState = { ...owner, totpSecret, backupCodes };
  writeOwnerState(state);
  await page.getByRole('button', { name: "J'ai conservé mes codes" }).click();

  await page.waitForURL('**/configuration/cle-d-acces');
  await page.getByRole('button', { name: /^(Plus tard|Terminer)$/ }).click();
  await page.waitForURL((url) => url.pathname === '/');
  return state;
}

export interface SignInOptions {
  method?: 'totp' | 'backup';
  /** Path to come back to after sign-in (`?suivant=`). */
  next?: string;
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
    if (!code) throw new Error('Plus aucun code de secours disponible pour le propriétaire e2e.');
    await page.getByRole('button', { name: 'Utiliser un code de secours' }).click();
    await page.getByLabel('Code de secours').fill(code);
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/connexion'));
    owner.backupCodes = rest;
    writeOwnerState(owner);
    return;
  }

  await page.getByLabel('Code à 6 chiffres').fill(await totpCode(owner.totpSecret));
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/connexion'));
}

/** Signs the current page's context out (POST form of /deconnexion). */
export async function signOut(page: Page): Promise<void> {
  await page.goto('/deconnexion');
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await page.waitForURL('**/connexion**');
}

/**
 * Ensures the owner exists and the page is signed in (TOTP). Creates the owner through
 * /configuration on a fresh database, otherwise signs in with the stored credentials.
 */
export async function createOwnerAndSignIn(page: Page): Promise<OwnerState> {
  const stored = readOwnerState();
  if (stored) {
    await signIn(page, stored);
    return stored;
  }
  if (!(await setupAvailable(page))) {
    throw new Error(
      'La base e2e a déjà un propriétaire mais aucun état local (.playwright/…/owner.json) : relancez Playwright (la configuration globale réinitialise la base).',
    );
  }
  return completeOwnerSetup(page);
}
