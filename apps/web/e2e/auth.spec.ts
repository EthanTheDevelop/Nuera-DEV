import { expect, test, type Page } from '@playwright/test';
import {
  E2E_OWNER,
  completeOwnerSetup,
  createOwnerAndSignIn,
  readOwnerState,
  setupAvailable,
  signIn,
  signOut,
  totpCode,
  type OwnerState,
} from './fixtures';

/**
 * Authentication journeys: owner setup with the SETUP_TOKEN, mandatory TOTP enrolment, backup
 * codes, sign-out, sign-in with TOTP, sign-in with a backup code, refusals.
 * The @configuration test runs first (project "configuration"); the others run on desktop and
 * mobile against the same owner.
 */
test.describe.configure({ mode: 'serial' });

/** Each test starts with a fresh browser context: signed out. Creates the owner if needed. */
async function ownerSignedOut(page: Page): Promise<OwnerState> {
  const stored = readOwnerState();
  if (stored) return stored;
  const owner = await createOwnerAndSignIn(page);
  await signOut(page);
  return owner;
}

async function submitPassword(page: Page, owner: OwnerState, password = owner.password): Promise<void> {
  await page.goto('/connexion');
  await page.getByLabel('E-mail').fill(owner.email);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
}

test('un visiteur non connecté est renvoyé vers la connexion ou la configuration', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/(connexion|configuration)/);
  const api = await page.request.get('/api/notifications');
  expect(api.status()).toBe(401);
  expect(await api.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
});

// Project "configuration" (playwright.config.ts) runs this test alone, first, on the fresh database.
test('configuration initiale : jeton refusé puis compte, double authentification et codes de secours', { tag: '@configuration' }, async ({ page }) => {
  // The global setup has just re-created the database: the owner creation must be offered.
  expect(await setupAvailable(page), 'formulaire de création du propriétaire').toBe(true);

  // Wrong token: refused, nothing created.
  await page.getByLabel('Jeton de configuration').fill('mauvais-jeton-de-configuration');
  await page.getByLabel('Nom', { exact: true }).fill(E2E_OWNER.name);
  await page.getByLabel('E-mail').fill(E2E_OWNER.email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(E2E_OWNER.password);
  await page.getByLabel('Confirmer le mot de passe').fill(E2E_OWNER.password);
  await page.getByRole('button', { name: 'Créer le compte' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Jeton de configuration incorrect.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Créer le compte propriétaire' })).toBeVisible();

  // Weak password: refused field by field, before the token is even checked.
  await page.getByLabel('Jeton de configuration').fill('mauvais-jeton-de-configuration');
  await page.getByLabel('Mot de passe', { exact: true }).fill('court');
  await page.getByLabel('Confirmer le mot de passe').fill('autre');
  await page.getByRole('button', { name: 'Créer le compte' }).click();
  const password = page.getByLabel('Mot de passe', { exact: true });
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#champ-password-erreur')).toContainText('12 caractères au minimum');
  await expect(page.locator('#champ-passwordConfirmation-erreur')).toContainText(/les deux mots de passe diffèrent/i);

  const owner = await completeOwnerSetup(page);
  expect(owner.backupCodes).toHaveLength(8);
  await expect(page).toHaveURL(/\/$/);

  // Setup is closed once the owner has 2FA.
  const response = await page.goto('/configuration');
  expect(response?.status()).toBe(404);
});

test("déconnexion puis connexion avec le code de l'application d'authentification", async ({ page }) => {
  const owner = await createOwnerAndSignIn(page);
  await signOut(page);
  await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();

  // Signed out: protected pages bounce back to /connexion with the return path.
  await page.goto('/parametres');
  await expect(page).toHaveURL(/\/connexion\?suivant=%2Fparametres/);

  await signIn(page, owner, { next: '/parametres' });
  await expect(page).toHaveURL(/\/parametres/);
  await signOut(page);
});

test('un mauvais mot de passe puis un mauvais code sont refusés', async ({ page }) => {
  const owner = await ownerSignedOut(page);

  await submitPassword(page, owner, 'mot-de-passe-faux-123');
  await expect(page.getByRole('alert').filter({ hasText: 'E-mail ou mot de passe incorrect.' })).toBeVisible();

  await submitPassword(page, owner);
  await page.waitForURL('**/connexion/deux-facteurs**');
  const valid = await totpCode(owner.totpSecret);
  const wrong = String((Number(valid) + 500_000) % 1_000_000).padStart(6, '0');
  await page.getByLabel('Code à 6 chiffres').fill(wrong);
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Code incorrect.' })).toBeVisible();

  // The challenge is still usable with the right code.
  await page.getByLabel('Code à 6 chiffres').fill(await totpCode(owner.totpSecret));
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/connexion'));
  await signOut(page);
});

test("connexion avec un code de secours, qui ne sert qu'une fois", async ({ page }) => {
  const owner = await ownerSignedOut(page);
  const used = owner.backupCodes[0];
  expect(used, 'au moins un code de secours inutilisé').toBeTruthy();

  await signIn(page, owner, { method: 'backup' });
  await expect(page).not.toHaveURL(/\/connexion/);
  await signOut(page);

  // The same code is refused the second time.
  await submitPassword(page, owner);
  await page.waitForURL('**/connexion/deux-facteurs**');
  await page.getByRole('button', { name: 'Utiliser un code de secours' }).click();
  await page.getByLabel('Code de secours').fill(used!);
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Code de secours inconnu ou déjà utilisé.' })).toBeVisible();
});

test('la configuration est fermée et la déconnexion exige le formulaire', async ({ page }) => {
  await createOwnerAndSignIn(page);
  const setup = await page.goto('/configuration');
  expect(setup?.status()).toBe(404);

  // GET /deconnexion never signs out by itself.
  await page.goto('/deconnexion');
  await expect(page.getByRole('heading', { name: 'Se déconnecter' })).toBeVisible();
  await page.goto('/connexion');
  await expect(page).not.toHaveURL(/\/connexion/);
  await signOut(page);
});
