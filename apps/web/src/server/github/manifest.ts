import 'server-only';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@/server/errors';
import { audit } from '@/server/security/audit';
import { decryptJson, encryptJson } from '@/server/security/crypto';
import { createOctokit, githubErrorStatus, toGithubAppError } from './client';
import { GITHUB_REQUIRED_PERMISSIONS, appUrl, githubWebUrl } from './config';
import { fetchInstallation, installUrl, toInstallationRecord } from './installations';
import { getStoredGithubApp, insertGithubApp, updateGithubApp } from './store';
import { clearGithubTokenCache } from './tokens';
import { manifestConversionSchema, type GithubConfig } from './types';

/**
 * GitHub App registration through the App Manifest flow (research §2.3):
 *   1. POST /api/integrations/github/manifest → auto-submitted form to github.com with a signed state
 *   2. GitHub → GET /api/integrations/github/callback?code&state → POST /app-manifests/{code}/conversions,
 *      credentials stored ENCRYPTED → redirect to the installation page
 *   3. GitHub → GET /api/integrations/github/setup?installation_id&setup_action[&state] → installation recorded
 * All three steps must happen within one hour ("You must complete all three steps … within one hour").
 */

export const MANIFEST_STATE_TTL_MS = 60 * 60_000;
/** Cookie that binds a state to the browser that started the flow (double submit). */
export const GITHUB_STATE_COOKIE = 'nuera_github_state';
export const GITHUB_STATE_COOKIE_PATH = '/api/integrations/github';

const APP_NAME_MAX = 34;

export interface GithubAppManifest {
  name: string;
  url: string;
  description: string;
  public: boolean;
  redirect_url: string;
  callback_urls: string[];
  setup_url: string;
  setup_on_update: boolean;
  request_oauth_on_install: boolean;
  hook_attributes: { url: string; active: boolean };
  default_permissions: Record<string, string>;
  default_events: string[];
}

/** « Nuera Dev · dev.nuera.studio » — at most 34 characters (GitHub rule). */
export function appNameForHost(host: string): string {
  const name = `Nuera Dev · ${host}`;
  return name.length <= APP_NAME_MAX ? name : name.slice(0, APP_NAME_MAX).trimEnd();
}

export function buildAppManifest(options: { appUrl?: string; public?: boolean } = {}): GithubAppManifest {
  const base = (options.appUrl ?? appUrl()).replace(/\/+$/, '');
  const host = new URL(base).host;
  const callback = `${base}/api/integrations/github/callback`;
  return {
    name: appNameForHost(host),
    url: base,
    description: `Nuera Dev (${host}) : clonage, branches, push et pull requests des dépôts autorisés.`,
    // Public: required to install the same app on an organisation AND a personal account (research §0.1).
    // A stranger installing it would only give Nuera Dev access to THEIR repositories, never the reverse,
    // and Nuera Dev ignores installations of accounts it did not install itself.
    public: options.public ?? true,
    redirect_url: callback,
    callback_urls: [callback],
    setup_url: `${base}/api/integrations/github/setup`,
    setup_on_update: true,
    request_oauth_on_install: false,
    // Required field; inactive: Nuera Dev polls GitHub instead of receiving webhooks.
    hook_attributes: { url: `${base}/api/integrations/github/webhook`, active: false },
    default_permissions: { ...GITHUB_REQUIRED_PERMISSIONS },
    default_events: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Signed state (AES-256-GCM via encryptJson: authenticated + opaque), bound to user and browser.
// ---------------------------------------------------------------------------------------------

const statePayloadSchema = z.object({
  v: z.literal(1),
  purpose: z.enum(['manifest', 'install']),
  nonce: z.string().min(16),
  userId: z.string().min(1),
  issuedAt: z.number().int(),
  /** Visibility requested in the manifest (carried to the callback). */
  public: z.boolean().optional(),
});
export type GithubStatePayload = z.infer<typeof statePayloadSchema>;

export function createGithubState(input: {
  purpose: GithubStatePayload['purpose'];
  userId: string;
  public?: boolean;
  now?: number;
}): {
  state: string;
  nonce: string;
} {
  const nonce = randomBytes(24).toString('base64url');
  const payload: GithubStatePayload = {
    v: 1,
    purpose: input.purpose,
    nonce,
    userId: input.userId,
    issuedAt: input.now ?? Date.now(),
    ...(input.public === undefined ? {} : { public: input.public }),
  };
  return { state: Buffer.from(encryptJson(payload), 'utf8').toString('base64url'), nonce };
}

export function verifyGithubState(input: {
  state: string | null | undefined;
  purpose: GithubStatePayload['purpose'];
  userId: string;
  cookieNonce: string | null | undefined;
  now?: number;
}): GithubStatePayload {
  const invalid = () =>
    new AppError('FORBIDDEN', 'Le retour de GitHub ne correspond pas à une demande de Nuera Dev.', {
      detail: 'Relancez la connexion depuis Intégrations (le lien est valable une heure).',
    });
  if (!input.state || input.state.length > 2048) throw invalid();
  let payload: GithubStatePayload;
  try {
    payload = statePayloadSchema.parse(decryptJson<unknown>(Buffer.from(input.state, 'base64url').toString('utf8')));
  } catch {
    throw invalid();
  }
  const now = input.now ?? Date.now();
  if (payload.purpose !== input.purpose || payload.userId !== input.userId) throw invalid();
  if (now - payload.issuedAt > MANIFEST_STATE_TTL_MS || payload.issuedAt - now > 60_000) {
    throw new AppError('FORBIDDEN', 'La demande de connexion GitHub a expiré.', {
      detail: "GitHub impose de terminer la création de l'application en moins d'une heure : relancez-la.",
    });
  }
  const cookie = input.cookieNonce ?? '';
  const a = Buffer.from(cookie);
  const b = Buffer.from(payload.nonce);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw invalid();
  return payload;
}

/** `Set-Cookie` value for the state nonce (HttpOnly, SameSite=Lax so it survives the GitHub redirect). */
export function stateCookie(nonce: string | null): string {
  const secure = process.env.NODE_ENV === 'production' || (process.env.APP_URL ?? '').startsWith('https:');
  const parts = [
    `${GITHUB_STATE_COOKIE}=${nonce ?? ''}`,
    `Path=${GITHUB_STATE_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${nonce ? Math.floor(MANIFEST_STATE_TTL_MS / 1000) : 0}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Step 1: auto-submitted form.
// ---------------------------------------------------------------------------------------------

const orgPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const startManifestInputSchema = z.object({
  /** Organisation that will own the app (`nuera-studio`); empty = the signed-in GitHub user. */
  organization: z
    .string()
    .trim()
    .max(39)
    .refine((value) => value === '' || orgPattern.test(value), "nom d'organisation GitHub invalide")
    .optional()
    .transform((value) => (value ? value : undefined)),
  /** Public app (default): installable on the organisation AND on the personal account. */
  public: z
    .union([z.boolean(), z.enum(['true', 'false', 'on', 'off'])])
    .optional()
    .transform((value) => (value === undefined ? true : value === true || value === 'true' || value === 'on')),
});
export type StartManifestInput = z.input<typeof startManifestInputSchema>;

export interface ManifestFormData {
  action: string;
  manifest: GithubAppManifest;
  state: string;
  nonce: string;
}

export async function startManifestFlow(input: { userId: string; organization?: string; public?: boolean }): Promise<ManifestFormData> {
  if (await getStoredGithubApp()) {
    throw new AppError('CONFLICT', 'Une application GitHub est déjà enregistrée.', {
      detail: "Déconnectez-la d'abord pour en créer une nouvelle.",
    });
  }
  const manifest = buildAppManifest({ public: input.public ?? true });
  const { state, nonce } = createGithubState({ purpose: 'manifest', userId: input.userId, public: manifest.public });
  const base = githubWebUrl();
  const path = input.organization
    ? `/organizations/${encodeURIComponent(input.organization)}/settings/apps/new`
    : '/settings/apps/new';
  const action = new URL(`${base}${path}`);
  action.searchParams.set('state', state);
  return { action: action.toString(), manifest, state, nonce };
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Self-contained page that posts the manifest to github.com (with a manual fallback button). */
export function renderManifestFormPage(form: ManifestFormData): string {
  const manifestJson = JSON.stringify(form.manifest);
  const note = form.manifest.public
    ? "Application publique : c'est nécessaire pour l'installer sur une organisation et sur un compte personnel. Une installation par un tiers ne donnerait accès qu'à ses propres dépôts, jamais aux vôtres, et Nuera Dev l'ignore."
    : 'Application privée : elle ne pourra être installée que sur le compte qui la possède.';
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Nuera Dev · Création de l'application GitHub</title>
</head>
<body style="margin:0;font-family:system-ui,sans-serif;background:#ffffff;color:#233353">
<main style="max-width:520px;margin:15vh auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 8px">Redirection vers GitHub…</h1>
<p style="font-size:14px;line-height:20px;color:#645e78;margin:0 0 16px">GitHub va vous demander de confirmer la création de l'application « ${escapeHtml(form.manifest.name)} ». Aucun jeton n'est saisi à la main.</p>
<p style="font-size:13px;line-height:18px;color:#645e78;margin:0 0 20px">${escapeHtml(note)}</p>
<form id="manifest-form" method="post" action="${escapeHtml(form.action)}">
<input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}">
<button type="submit" style="font:inherit;font-size:14px;padding:12px 18px;border-radius:12px;border:1px solid #141830;background:#4368b1;color:#ffffff;cursor:pointer">Continuer vers GitHub</button>
</form>
</main>
<script>document.getElementById('manifest-form').submit();</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------------------------
// Step 2: code conversion.
// ---------------------------------------------------------------------------------------------

export async function completeManifestConversion(input: { code: string; userId: string; public?: boolean }): Promise<{
  slug: string;
  installUrl: string;
  installNonce: string;
}> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.code)) {
    throw new AppError('VALIDATION', 'Code de retour GitHub invalide.');
  }
  if (await getStoredGithubApp()) {
    throw new AppError('CONFLICT', 'Une application GitHub est déjà enregistrée.');
  }
  // Documented call: no Authorization header (research §2.3 step 4).
  const octokit = createOctokit();
  let conversion;
  try {
    const { data } = await octokit.request('POST /app-manifests/{code}/conversions', { code: input.code });
    conversion = manifestConversionSchema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new AppError('UPSTREAM', "Réponse inattendue de GitHub pendant la création de l'application.");
    }
    const status = githubErrorStatus(error);
    if (status === 404 || status === 422) {
      throw new AppError('CONFLICT', "GitHub a refusé le code de création de l'application.", {
        detail: 'Le code a expiré ou a déjà servi : relancez la connexion depuis Intégrations.',
      });
    }
    throw toGithubAppError(error, "la création de l'application");
  }

  const owner = conversion.owner
    ? { login: conversion.owner.login, id: conversion.owner.id, type: conversion.owner.type ?? 'User' }
    : null;
  const config: GithubConfig = {
    mode: 'app',
    appId: conversion.id,
    slug: conversion.slug,
    clientId: conversion.client_id,
    name: conversion.name,
    htmlUrl: conversion.html_url,
    owner,
    public: input.public ?? true,
    permissionsRequested: conversion.permissions ?? { ...GITHUB_REQUIRED_PERMISSIONS },
    createdAt: new Date().toISOString(),
    // The owner of the app is trusted from the start; other accounts join through the setup step.
    allowedAccountIds: owner ? [owner.id] : [],
    installations: [],
    ignoredInstallations: 0,
    repoCount: null,
    consecutiveFailures: 0,
    failingSince: null,
    lastCheck: null,
    history: [],
  };
  await insertGithubApp(config, {
    privateKeyPem: conversion.pem,
    clientSecret: conversion.client_secret,
    webhookSecret: conversion.webhook_secret ?? null,
  });
  clearGithubTokenCache();
  await audit({
    action: 'integration.github.app_created',
    summary: `application GitHub « ${conversion.name} » créée${owner ? ` pour ${owner.login}` : ''}`,
    targetType: 'integration',
    targetId: 'github',
    actorUserId: input.userId,
    metadata: { appId: conversion.id, slug: conversion.slug, owner: owner?.login ?? null },
  });
  const { state, nonce } = createGithubState({ purpose: 'install', userId: input.userId });
  return { slug: conversion.slug, installUrl: installUrl(conversion.slug, state), installNonce: nonce };
}

// ---------------------------------------------------------------------------------------------
// Step 3: installation callback (setup URL).
// ---------------------------------------------------------------------------------------------

export type SetupOutcome = 'installed' | 'updated' | 'requested' | 'unknown_installation';

/**
 * Records an installation reported by the setup URL. The `installation_id` is verified with the app
 * JWT (« Bad actors can hit this URL with a spoofed installation_id »). A NEW account is only
 * allow-listed when the redirect carries a valid state minted by Nuera Dev for this user and browser.
 */
export async function handleInstallationSetup(input: {
  installationId: number | null;
  setupAction: string | null;
  userId: string;
  stateValid: boolean;
}): Promise<{ outcome: SetupOutcome; account: string | null }> {
  if (input.setupAction === 'request') return { outcome: 'requested', account: null };
  if (!input.installationId) throw new AppError('VALIDATION', 'Installation GitHub manquante dans le retour de GitHub.');
  const stored = await getStoredGithubApp();
  if (!stored) throw new AppError('CONFLICT', "Aucune application GitHub n'est enregistrée.");

  const installation = await fetchInstallation(input.installationId);
  if (!installation || !installation.account) {
    return { outcome: 'unknown_installation', account: null };
  }
  const accountId = installation.account.id;
  const alreadyAllowed = stored.config.allowedAccountIds.includes(accountId);
  const alreadyRecorded = stored.config.installations.some((item) => item.id === installation.id);
  if (!alreadyAllowed && !input.stateValid) {
    await audit({
      action: 'integration.github.installation_ignored',
      summary: `installation GitHub non reconnue ignorée (${installation.account.login})`,
      targetType: 'integration',
      targetId: 'github',
      actorUserId: input.userId,
      metadata: { installationId: installation.id, account: installation.account.login },
    });
    return { outcome: 'unknown_installation', account: installation.account.login };
  }

  // The status itself is computed by the check that the setup route runs right after.
  await updateGithubApp((config) => {
    const previous = config.installations.find((item) => item.id === installation.id);
    const record = toInstallationRecord(installation, previous);
    return {
      ...config,
      allowedAccountIds: [...new Set([...config.allowedAccountIds, accountId])],
      installations: [...config.installations.filter((item) => item.id !== installation.id), record],
    };
  });
  await audit({
    action: alreadyRecorded ? 'integration.github.installation_updated' : 'integration.github.installed',
    summary: alreadyRecorded
      ? `installation GitHub mise à jour (${installation.account.login})`
      : `application GitHub installée sur ${installation.account.login}`,
    targetType: 'integration',
    targetId: 'github',
    actorUserId: input.userId,
    metadata: {
      installationId: installation.id,
      account: installation.account.login,
      repositorySelection: installation.repository_selection ?? null,
    },
  });
  return { outcome: alreadyRecorded ? 'updated' : 'installed', account: installation.account.login };
}
