import 'server-only';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@/server/errors';
import { audit } from '@/server/security/audit';
import { decryptJson, encryptJson, SecretScopes } from '@/server/security/crypto';
import { createOctokit, githubErrorStatus, toGithubAppError } from './client';
import { GITHUB_REQUIRED_PERMISSIONS, MAX_GITHUB_SOURCES_PER_SPACE, appUrl, githubWebUrl } from './config';
import { fetchInstallation, findSourceForInstallation, installUrl, toInstallationRecord } from './installations';
import { countGithubSources, findGithubSource, GITHUB_APP_ALREADY_REGISTERED, insertGithubSource, updateGithubSource, type StoredGithubSource } from './store';
import { getAppCredentials } from './tokens';
import { manifestConversionSchema, type GithubConfig, type InstallationApi } from './types';

/**
 * GitHub App registration through the App Manifest flow (research §2.3):
 *   1. POST /api/integrations/github/manifest → auto-submitted form to github.com with a signed state
 *   2. GitHub → GET /api/integrations/github/callback?code&state → POST /app-manifests/{code}/conversions,
 *      credentials stored ENCRYPTED → redirect to the installation page
 *   3. GitHub → GET /api/integrations/github/setup?installation_id&setup_action[&state] → installation recorded
 * All three steps must happen within one hour ("You must complete all three steps … within one hour").
 *
 * A space has up to MAX_GITHUB_SOURCES_PER_SPACE sources (one GitHub App each, MULTICOMPTE §7): the
 * signed state (v2) carries the account, its space and the source id allocated at step 1; each app
 * gets a unique name (GitHub App names are global) and is private unless « Application publique » is
 * switched on. Every app shares the same setup URL: the source is read from the state, or found by
 * asking GitHub with the JWT of each source of the space.
 */

export const MANIFEST_STATE_TTL_MS = 60 * 60_000;
/** Cookie that binds a state to the browser that started the flow (double submit), one per account. */
export const GITHUB_STATE_COOKIE = 'nuera_github_state';
export const GITHUB_STATE_COOKIE_PATH = '/api/integrations/github';

/** `nuera_github_state_<8 hex>`: the cookie of this account (two accounts never share a nonce). */
export function stateCookieName(userId: string): string {
  return `${GITHUB_STATE_COOKIE}_${createHash('sha256').update(userId).digest('hex').slice(0, 8)}`;
}

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

/** 4 random hex characters: GitHub App names are unique across GitHub. */
export function appNameSuffix(): string {
  return randomBytes(2).toString('hex');
}

/**
 * « Nuera Dev 7f3a · dev.nuera.studio » — unique thanks to the suffix, at most 34 characters (GitHub
 * rule: a long host is cut, never the suffix). Without suffix: « Nuera Dev · dev.nuera.studio ».
 */
export function appNameForHost(host: string, suffix?: string): string {
  const name = suffix ? `Nuera Dev ${suffix} · ${host}` : `Nuera Dev · ${host}`;
  return name.length <= APP_NAME_MAX ? name : name.slice(0, APP_NAME_MAX).trimEnd();
}

export function buildAppManifest(options: { appUrl?: string; public?: boolean; suffix?: string } = {}): GithubAppManifest {
  const base = (options.appUrl ?? appUrl()).replace(/\/+$/, '');
  const host = new URL(base).host;
  const callback = `${base}/api/integrations/github/callback`;
  return {
    name: appNameForHost(host, options.suffix),
    url: base,
    description: `Nuera Dev (${host}) : clonage, branches, push et pull requests des dépôts autorisés.`,
    // Private by default (MULTICOMPTE §7). Public is required to install the same app on an
    // organisation AND a personal account (research §0.1): a stranger installing it would only give
    // Nuera Dev access to THEIR repositories, never the reverse, and Nuera Dev ignores installations
    // of accounts it did not install itself.
    public: options.public ?? false,
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

const statePurpose = z.enum(['manifest', 'install']);

/** v1 (before several sources): no space, no source. Still read during the hour after an update. */
const statePayloadV1Schema = z.object({
  v: z.literal(1),
  purpose: statePurpose,
  nonce: z.string().min(16),
  userId: z.string().min(1),
  issuedAt: z.number().int(),
  public: z.boolean().optional(),
});

const statePayloadV2Schema = z.object({
  v: z.literal(2),
  purpose: statePurpose,
  nonce: z.string().min(16),
  userId: z.string().min(1),
  /** Space the source belongs to (the account's space when the flow started). */
  spaceId: z.uuid(),
  /** Source allocated at step 1 (manifest) or being installed (install). */
  sourceId: z.uuid().nullable(),
  issuedAt: z.number().int(),
  /** Visibility requested in the manifest (carried to the callback). */
  public: z.boolean().optional(),
});

export interface GithubStatePayload {
  v: 1 | 2;
  purpose: 'manifest' | 'install';
  nonce: string;
  userId: string;
  /** null for a v1 state (the caller uses its own space). */
  spaceId: string | null;
  sourceId: string | null;
  issuedAt: number;
  public?: boolean;
}

export function createGithubState(input: {
  purpose: GithubStatePayload['purpose'];
  userId: string;
  spaceId: string;
  sourceId?: string | null;
  public?: boolean;
  now?: number;
}): {
  state: string;
  nonce: string;
} {
  const nonce = randomBytes(24).toString('base64url');
  const payload: z.infer<typeof statePayloadV2Schema> = {
    v: 2,
    purpose: input.purpose,
    nonce,
    userId: input.userId,
    spaceId: input.spaceId,
    sourceId: input.sourceId ?? null,
    issuedAt: input.now ?? Date.now(),
    ...(input.public === undefined ? {} : { public: input.public }),
  };
  // Bound to the account: the state of another account never decrypts.
  return { state: Buffer.from(encryptJson(payload, SecretScopes.githubManifestState(input.userId)), 'utf8').toString('base64url'), nonce };
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
    const raw = decryptJson<unknown>(Buffer.from(input.state, 'base64url').toString('utf8'), SecretScopes.githubManifestState(input.userId));
    const v2 = statePayloadV2Schema.safeParse(raw);
    payload = v2.success ? { ...v2.data } : { ...statePayloadV1Schema.parse(raw), spaceId: null, sourceId: null };
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

/**
 * `Set-Cookie` value for the state nonce of an account (HttpOnly, SameSite=Lax so it survives the
 * GitHub redirect). `userId` null: the historical shared cookie (only ever cleared).
 */
export function stateCookie(nonce: string | null, userId: string | null = null): string {
  const secure = process.env.NODE_ENV === 'production' || (process.env.APP_URL ?? '').startsWith('https:');
  const parts = [
    `${userId ? stateCookieName(userId) : GITHUB_STATE_COOKIE}=${nonce ?? ''}`,
    `Path=${GITHUB_STATE_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${nonce ? Math.floor(MANIFEST_STATE_TTL_MS / 1000) : 0}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Nonce cookie of this account (the historical shared name is still read). */
export function readStateCookie(header: string | null, userId: string): string | null {
  return readCookie(header, stateCookieName(userId)) ?? readCookie(header, GITHUB_STATE_COOKIE);
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
  /**
   * Public app: installable on the organisation AND on the personal account. Private by default
   * (MULTICOMPTE §7): only on the account that owns it.
   */
  public: z
    .union([z.boolean(), z.enum(['true', 'false', 'on', 'off'])])
    .optional()
    .transform((value) => value === true || value === 'true' || value === 'on'),
});
export type StartManifestInput = z.input<typeof startManifestInputSchema>;

export interface ManifestFormData {
  action: string;
  manifest: GithubAppManifest;
  state: string;
  nonce: string;
  /** Source id allocated for the app being created. */
  sourceId: string;
}

export const SOURCE_LIMIT_MESSAGE = `Votre espace a déjà ${MAX_GITHUB_SOURCES_PER_SPACE} sources GitHub : déconnectez-en une d'abord.`;

/** Step 1 for a space: allocates the source id, signs the state, builds the manifest (unique name). */
export async function startManifestFlow(input: { userId: string; spaceId: string; organization?: string; public?: boolean }): Promise<ManifestFormData> {
  if ((await countGithubSources(input.spaceId)) >= MAX_GITHUB_SOURCES_PER_SPACE) {
    throw new AppError('CONFLICT', SOURCE_LIMIT_MESSAGE, { reason: 'SOURCE_LIMIT' });
  }
  const sourceId = randomUUID();
  const manifest = buildAppManifest({ public: input.public ?? false, suffix: appNameSuffix() });
  const { state, nonce } = createGithubState({ purpose: 'manifest', userId: input.userId, spaceId: input.spaceId, sourceId, public: manifest.public });
  const base = githubWebUrl();
  const path = input.organization
    ? `/organizations/${encodeURIComponent(input.organization)}/settings/apps/new`
    : '/settings/apps/new';
  const action = new URL(`${base}${path}`);
  action.searchParams.set('state', state);
  return { action: action.toString(), manifest, state, nonce, sourceId };
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

export async function completeManifestConversion(input: { code: string; userId: string; spaceId: string; sourceId?: string | null; public?: boolean }): Promise<{
  sourceId: string;
  slug: string;
  installUrl: string;
  installNonce: string;
}> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.code)) {
    throw new AppError('VALIDATION', 'Code de retour GitHub invalide.');
  }
  const sourceId = input.sourceId ?? randomUUID();
  // A replayed callback (same state): the source already exists.
  if (input.sourceId && (await findGithubSource({ spaceId: input.spaceId, sourceId: input.sourceId }))) {
    throw new AppError('CONFLICT', GITHUB_APP_ALREADY_REGISTERED);
  }
  if ((await countGithubSources(input.spaceId)) >= MAX_GITHUB_SOURCES_PER_SPACE) {
    throw new AppError('CONFLICT', SOURCE_LIMIT_MESSAGE, { reason: 'SOURCE_LIMIT' });
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
    public: input.public ?? false,
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
  await insertGithubSource({
    id: sourceId,
    spaceId: input.spaceId,
    createdByUserId: input.userId,
    label: owner?.login ?? null,
    config,
    secrets: {
      privateKeyPem: conversion.pem,
      clientSecret: conversion.client_secret,
      webhookSecret: conversion.webhook_secret ?? null,
    },
  });
  await audit({
    action: 'integration.github.app_created',
    summary: `application GitHub « ${conversion.name} » créée${owner ? ` pour ${owner.login}` : ''}`,
    targetType: 'integration',
    targetId: sourceId,
    actorUserId: input.userId,
    spaceId: input.spaceId,
    metadata: { appId: conversion.id, slug: conversion.slug, owner: owner?.login ?? null, public: config.public },
  });
  const { state, nonce } = createGithubState({ purpose: 'install', userId: input.userId, spaceId: input.spaceId, sourceId });
  return { sourceId, slug: conversion.slug, installUrl: installUrl(conversion.slug, state), installNonce: nonce };
}

// ---------------------------------------------------------------------------------------------
// Step 3: installation callback (setup URL).
// ---------------------------------------------------------------------------------------------

export type SetupOutcome = 'installed' | 'updated' | 'requested' | 'unknown_installation';

/**
 * Records an installation reported by the setup URL (shared by every app). The source comes from the
 * state (`sourceId`, a source of the space), otherwise it is found by asking GitHub with the JWT of
 * each source of the space (« Bad actors can hit this URL with a spoofed installation_id »: an id
 * no source of the space knows is unknown). A NEW account is only allow-listed when the redirect
 * carries a valid state minted by Nuera Dev for this account and browser (and for this source).
 */
export async function handleInstallationSetup(input: {
  installationId: number | null;
  setupAction: string | null;
  userId: string;
  spaceId: string;
  /** Source named by a valid state, or null. */
  sourceId: string | null;
  stateValid: boolean;
}): Promise<{ outcome: SetupOutcome; account: string | null; sourceId: string | null }> {
  if (input.setupAction === 'request') return { outcome: 'requested', account: null, sourceId: input.sourceId };
  if (!input.installationId) throw new AppError('VALIDATION', 'Installation GitHub manquante dans le retour de GitHub.');
  if ((await countGithubSources(input.spaceId)) === 0) throw new AppError('CONFLICT', "Aucune application GitHub n'est enregistrée.");

  let source: StoredGithubSource | null = null;
  let installation: InstallationApi | null = null;
  if (input.sourceId) {
    source = await findGithubSource({ spaceId: input.spaceId, sourceId: input.sourceId });
    if (source) installation = await fetchInstallation(input.installationId, getAppCredentials(source));
  }
  if (!installation) {
    const found = await findSourceForInstallation({ spaceId: input.spaceId, installationId: input.installationId });
    source = found?.source ?? null;
    installation = found?.installation ?? null;
  }
  if (!source || !installation || !installation.account) {
    return { outcome: 'unknown_installation', account: null, sourceId: null };
  }
  const account = installation.account;
  const alreadyAllowed = source.config.allowedAccountIds.includes(account.id);
  const alreadyRecorded = source.config.installations.some((item) => item.id === installation.id);
  // A valid state for ANOTHER source of the space does not allow-list an account in this one.
  const stateForThisSource = input.stateValid && (input.sourceId === null || input.sourceId === source.id);
  if (!alreadyAllowed && !stateForThisSource) {
    await audit({
      action: 'integration.github.installation_ignored',
      summary: `installation GitHub non reconnue ignorée (${account.login})`,
      targetType: 'integration',
      targetId: source.id,
      actorUserId: input.userId,
      spaceId: input.spaceId,
      metadata: { installationId: installation.id, account: account.login },
    });
    return { outcome: 'unknown_installation', account: account.login, sourceId: source.id };
  }

  const record = installation;
  // The status itself is computed by the check that the setup route runs right after.
  await updateGithubSource({ spaceId: input.spaceId, sourceId: source.id }, (config) => {
    const previous = config.installations.find((item) => item.id === record.id);
    return {
      ...config,
      allowedAccountIds: [...new Set([...config.allowedAccountIds, account.id])],
      installations: [...config.installations.filter((item) => item.id !== record.id), toInstallationRecord(record, previous)],
    };
  });
  await audit({
    action: alreadyRecorded ? 'integration.github.installation_updated' : 'integration.github.installed',
    summary: alreadyRecorded ? `installation GitHub mise à jour (${account.login})` : `application GitHub installée sur ${account.login}`,
    targetType: 'integration',
    targetId: source.id,
    actorUserId: input.userId,
    spaceId: input.spaceId,
    metadata: {
      installationId: installation.id,
      account: account.login,
      repositorySelection: installation.repository_selection ?? null,
    },
  });
  return { outcome: alreadyRecorded ? 'updated' : 'installed', account: account.login, sourceId: source.id };
}
